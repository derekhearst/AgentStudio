import { and, asc, desc, eq, gte, lte, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { jobLeases, jobPolicies, jobs, type JobRow, type JobStatus } from './jobs.schema'
import { logger } from '$lib/observability/logger'

/**
 * Wave 4 #17 phase 1 — durable job queue server helpers.
 *
 * Postgres-backed queue with `FOR UPDATE SKIP LOCKED` for safe concurrent claiming. The
 * worker loop (Phase 2) calls `claimNextJob` in a polling loop; this module exposes the
 * primitives so callers can also enqueue + cancel + inspect.
 *
 * Lifecycle invariants:
 *   - enqueue → status='pending', attemptCount=0
 *   - claimNextJob → status='leased', leaseExpiresAt set, attemptCount unchanged (incremented
 *     when the worker actually starts the work via beginJob)
 *   - beginJob → status='running', startedAt set, attemptCount += 1
 *   - heartbeatJob → extends lease + updates lease row's heartbeatAt
 *   - completeJob → status='completed', finishedAt set, result stored
 *   - failJob → if attemptCount < maxAttempts: status='retry_wait' + scheduledAt = now+backoff;
 *               else: status='failed', finishedAt set, error stored
 *   - cancelJob → status='canceled' (cooperative; worker checks at safe boundaries)
 */

// ─────────── Enqueue ───────────

const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 5_000
const DEFAULT_QUEUE = 'default'

export type EnqueueJobInput = {
	type: string
	payload?: Record<string, unknown>
	priority?: number
	queue?: string
	dedupeKey?: string
	scheduledAt?: Date
	maxAttempts?: number
	runId?: string | null
	sessionId?: string | null
	projectId?: string | null
	userId?: string | null
}

/**
 * Enqueue a new job. When `dedupeKey` is set and a row with the same `(type, dedupeKey)` already
 * exists, returns the EXISTING row instead of creating a duplicate (idempotency contract).
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<JobRow> {
	const policy = await getPolicyForType(input.type)
	const insertValues = {
		type: input.type,
		status: 'pending' as JobStatus,
		priority: input.priority ?? 100,
		queue: input.queue ?? DEFAULT_QUEUE,
		dedupeKey: input.dedupeKey ?? null,
		scheduledAt: input.scheduledAt ?? new Date(),
		maxAttempts: input.maxAttempts ?? policy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		payload: input.payload ?? {},
		runId: input.runId ?? null,
		sessionId: input.sessionId ?? null,
		projectId: input.projectId ?? null,
		userId: input.userId ?? null,
	}

	if (input.dedupeKey) {
		// `(type, dedupeKey)` is unique — INSERT … ON CONFLICT DO NOTHING + a follow-up SELECT
		// returns the existing row when there's a collision.
		const inserted = await db.insert(jobs).values(insertValues).onConflictDoNothing().returning()
		if (inserted.length > 0) return inserted[0]
		const [existing] = await db
			.select()
			.from(jobs)
			.where(and(eq(jobs.type, input.type), eq(jobs.dedupeKey, input.dedupeKey)))
			.limit(1)
		if (!existing) {
			throw new Error(`enqueueJob: dedupe collision but row not found — type=${input.type} dedupeKey=${input.dedupeKey}`)
		}
		return existing
	}

	const [row] = await db.insert(jobs).values(insertValues).returning()
	return row
}

// ─────────── Claim / lease ───────────

/**
 * Build an `and column in ('a', 'b')` SQL fragment from app-controlled values. Returns an
 * empty string when values is undefined/empty. Single-quotes are stripped defensively even
 * though callers only pass alphanumeric handler names + queue names.
 */
function buildInClause(column: 'queue' | 'type', values: string[] | undefined): string {
	if (!values || values.length === 0) return ''
	const escaped = values.map((v) => `'${v.replace(/'/g, "''").replace(/[^a-zA-Z0-9_:-]/g, '')}'`)
	return `and ${column} in (${escaped.join(', ')})`
}

export type ClaimJobOptions = {
	workerId: string
	/** Filter by queue name(s). Default: claim from any queue. */
	queues?: string[]
	/** Lease TTL — if the worker doesn't heartbeat within this window the lease expires. */
	leaseTtlMs?: number
	/** Filter by job type(s). Default: claim from any type. */
	types?: string[]
}

/**
 * Atomic claim of the next eligible job. Uses `FOR UPDATE SKIP LOCKED` so concurrent workers
 * don't fight over the same row. Returns null when no job is available.
 *
 * Eligible:
 *   status IN (pending, retry_wait) AND scheduled_at <= now()
 *   OR status = leased AND lease_expires_at < now() (re-claim a stale lease)
 *
 * Ordering: priority desc, scheduled_at asc (oldest within priority first).
 */
export async function claimNextJob(opts: ClaimJobOptions): Promise<JobRow | null> {
	const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
	const newLeaseExpiresAt = new Date(Date.now() + leaseTtlMs)

	// Build the optional queue/type filters as plain SQL string fragments (no parameter
	// binding). The values are application-controlled (handler-registered names + a tiny
	// fixed queue-name allowlist), not user input, so manual single-quote escape is safe.
	const queueClause = buildInClause('queue', opts.queues)
	const typeClause = buildInClause('type', opts.types)

	// Two-step claim inside a transaction: SELECT FOR UPDATE SKIP LOCKED + UPDATE. Splitting
	// avoids the postgres.js prepared-statement re-parsing issues we hit with conditional CTE
	// fragments. The transaction is short-lived (single round-trip-ish) so lock contention
	// stays low.
	const claimedJob = await db.transaction(async (tx) => {
		const candidateText = `
			select id from jobs
			where (
				(status in ('pending'::job_status, 'retry_wait'::job_status) and scheduled_at <= now())
				or (status = 'leased'::job_status and lease_expires_at < now())
			)
			${queueClause}
			${typeClause}
			order by priority desc, scheduled_at asc
			limit 1
			for update skip locked
		`
		const candidateResult = await tx.execute(drizzleSql.raw(candidateText))
		const candidateRows = (candidateResult as unknown as { rows?: { id: string }[] }).rows
			?? (candidateResult as unknown as { id: string }[])
		const candidate = Array.isArray(candidateRows) ? candidateRows[0] : null
		if (!candidate) return null
		const [updated] = await tx
			.update(jobs)
			.set({ status: 'leased', leaseExpiresAt: newLeaseExpiresAt, updatedAt: new Date() })
			.where(eq(jobs.id, candidate.id))
			.returning()
		return updated ?? null
	})

	if (!claimedJob) return null
	const now = new Date()

	// Insert the lease record so the audit history shows what worker has the job.
	await db.insert(jobLeases).values({
		jobId: claimedJob.id,
		workerId: opts.workerId,
		heartbeatAt: now,
		expiresAt: newLeaseExpiresAt,
	})

	return claimedJob
}

/**
 * Mark the leased job as actually running. Bumps `attemptCount` so retries are visible in the
 * audit trail. The worker calls this AFTER claiming + before doing any real work, so a crashed
 * worker between claim and begin still leaves the row claimable when the lease expires.
 */
export async function beginJob(jobId: string): Promise<JobRow | null> {
	const [row] = await db
		.update(jobs)
		.set({
			status: 'running',
			startedAt: new Date(),
			attemptCount: drizzleSql`${jobs.attemptCount} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(jobs.id, jobId))
		.returning()
	return row ?? null
}

/**
 * Extend the active lease + update the lease row's heartbeatAt. Workers should call this every
 * (leaseTtlMs / 3) or so to keep the lease fresh. Returns null when the job no longer exists or
 * has been canceled (signals the worker to stop).
 */
export async function heartbeatJob(jobId: string, leaseTtlMs?: number): Promise<JobRow | null> {
	const ttl = leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
	const newExpiry = new Date(Date.now() + ttl)
	const [row] = await db
		.update(jobs)
		.set({ leaseExpiresAt: newExpiry, updatedAt: new Date() })
		.where(eq(jobs.id, jobId))
		.returning()
	if (!row) return null
	if (row.status === 'canceled') return null
	// Update the most recent lease row's heartbeat. Best-effort — the cached lease_expires_at
	// on jobs is the source of truth for the claim path.
	await db.execute(drizzleSql`
		update job_leases
		set heartbeat_at = now(), expires_at = ${newExpiry}
		where job_id = ${jobId}
		and id = (select id from job_leases where job_id = ${jobId} order by heartbeat_at desc limit 1)
	`)
	return row
}

// ─────────── Terminal transitions ───────────

export async function completeJob(jobId: string, result?: Record<string, unknown>): Promise<JobRow | null> {
	const [row] = await db
		.update(jobs)
		.set({
			status: 'completed',
			finishedAt: new Date(),
			result: result ?? null,
			leaseExpiresAt: null,
			updatedAt: new Date(),
		})
		.where(eq(jobs.id, jobId))
		.returning()

	// Wave 5 #20 phase 4 — emit lifecycle metrics when a job finishes. Best-effort: any
	// failure to record is swallowed. Duration is `finishedAt - startedAt` (or 0 if startedAt
	// is missing because of an unusual lifecycle path).
	if (row) {
		void emitJobLifecycleMetric(row, 'completed')
	}
	return row ?? null
}

export type FailJobOptions = {
	error: { message: string; stack?: string }
	/** Override the policy's backoff for this specific failure. */
	backoffMs?: number
}

/**
 * Fail-and-maybe-retry. If `attemptCount < maxAttempts`, transitions to `retry_wait` with a
 * future `scheduledAt`. Otherwise transitions to terminal `failed`.
 */
export async function failJob(jobId: string, opts: FailJobOptions): Promise<JobRow | null> {
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
	if (!job) return null

	const policy = await getPolicyForType(job.type)
	const backoffMs = opts.backoffMs ?? policy?.backoffMs ?? DEFAULT_BACKOFF_MS

	if (job.attemptCount < job.maxAttempts) {
		const [row] = await db
			.update(jobs)
			.set({
				status: 'retry_wait',
				scheduledAt: new Date(Date.now() + backoffMs),
				leaseExpiresAt: null,
				error: opts.error,
				updatedAt: new Date(),
			})
			.where(eq(jobs.id, jobId))
			.returning()
		return row ?? null
	}

	const [row] = await db
		.update(jobs)
		.set({
			status: 'failed',
			finishedAt: new Date(),
			error: opts.error,
			leaseExpiresAt: null,
			updatedAt: new Date(),
		})
		.where(eq(jobs.id, jobId))
		.returning()

	// Wave 5 #20 — open a review item when a job exhausts retries and lands at terminal
	// failed. DedupeKey on jobId so multiple readers/observers don't multiply the rows.
	// Best-effort: failure to open the review item never blocks the job state transition.
	if (row) {
		void (async () => {
			try {
				const { openReviewItem } = await import('$lib/observability/review.server')
				await openReviewItem({
					type: 'job_failure',
					severity: 'critical',
					summary: `Job ${row.type} failed after ${row.attemptCount} attempt(s): ${opts.error.message.slice(0, 120)}`,
					payload: {
						jobType: row.type,
						attemptCount: row.attemptCount,
						maxAttempts: row.maxAttempts,
						error: opts.error,
					},
					runId: row.runId,
					jobId: row.id,
					dedupeKey: `job:${row.id}`,
				})
			} catch (err) {
				logger.warn('[jobs] review item open failed (non-fatal)', { err })
			}
		})()
		void emitJobLifecycleMetric(row, 'failed')
	}
	return row ?? null
}

/**
 * Wave 5 #20 phase 4 — emit duration + count metrics for a finished job. Records two rows:
 *   jobs.duration_ms with dimensions {type, queue, status} (so the dashboard can render
 *     P50/P95 latency by job type)
 *   jobs.lifecycle.<status> with dimensions {type, queue} (so the dashboard can render
 *     completion / failure rate over time)
 *
 * Best-effort: any failure to record is swallowed and a warn is logged. The job state
 * transition has already been committed by the time this fires, so an outage in the metrics
 * pipeline can never roll back the lifecycle change.
 */
async function emitJobLifecycleMetric(row: JobRow, status: 'completed' | 'failed' | 'canceled'): Promise<void> {
	try {
		const { recordMetric } = await import('$lib/observability/metrics.server')
		const startedAt = row.startedAt ? new Date(row.startedAt).getTime() : null
		const finishedAt = row.finishedAt ? new Date(row.finishedAt).getTime() : Date.now()
		const durationMs = startedAt != null ? Math.max(0, finishedAt - startedAt) : 0
		await recordMetric({
			metric: 'jobs.duration_ms',
			dimension: { type: row.type, queue: row.queue, status },
			value: durationMs,
		})
		await recordMetric({
			metric: `jobs.lifecycle.${status}`,
			dimension: { type: row.type, queue: row.queue },
			value: 1,
		})
	} catch (err) {
		logger.warn('[jobs] emitJobLifecycleMetric failed (non-fatal)', { err })
	}
}

export async function cancelJob(jobId: string, reason?: string): Promise<JobRow | null> {
	const [row] = await db
		.update(jobs)
		.set({
			status: 'canceled',
			finishedAt: new Date(),
			error: reason ? { message: reason } : null,
			leaseExpiresAt: null,
			updatedAt: new Date(),
		})
		.where(eq(jobs.id, jobId))
		.returning()

	if (row) {
		void emitJobLifecycleMetric(row, 'canceled')
	}
	return row ?? null
}

// ─────────── Read helpers ───────────

export async function getJobById(jobId: string): Promise<JobRow | null> {
	const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
	return row ?? null
}

export type ListJobsFilters = {
	status?: JobStatus | JobStatus[]
	type?: string
	queue?: string
	userId?: string
	runId?: string
	limit?: number
	since?: Date
}

export async function listJobs(filters: ListJobsFilters = {}): Promise<JobRow[]> {
	const where = []
	if (filters.status) {
		const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
		where.push(
			drizzleSql`${jobs.status} in (${drizzleSql.join(statuses.map((s) => drizzleSql`${s}`), drizzleSql`, `)})`,
		)
	}
	if (filters.type) where.push(eq(jobs.type, filters.type))
	if (filters.queue) where.push(eq(jobs.queue, filters.queue))
	if (filters.userId) where.push(eq(jobs.userId, filters.userId))
	if (filters.runId) where.push(eq(jobs.runId, filters.runId))
	if (filters.since) where.push(gte(jobs.createdAt, filters.since))

	return db
		.select()
		.from(jobs)
		.where(where.length > 0 ? and(...where) : undefined)
		.orderBy(desc(jobs.createdAt))
		.limit(filters.limit ?? 100)
}

/**
 * Find jobs whose lease has expired without a recent heartbeat. The worker calls this on a
 * separate timer to recover stuck jobs — re-eligible for claim.
 */
export async function findStaleLeases(now = new Date()): Promise<JobRow[]> {
	return db
		.select()
		.from(jobs)
		.where(and(eq(jobs.status, 'leased'), lte(jobs.leaseExpiresAt, now)))
		.orderBy(asc(jobs.leaseExpiresAt))
}

// ─────────── Policies ───────────

export async function getPolicyForType(jobType: string) {
	const [row] = await db
		.select()
		.from(jobPolicies)
		.where(eq(jobPolicies.jobType, jobType))
		.limit(1)
	return row ?? null
}

export type UpsertJobPolicyInput = {
	jobType: string
	maxAttempts?: number
	backoffMs?: number
	concurrencyKey?: string | null
	concurrencyLimit?: number | null
	timeoutMs?: number
	cancelBehavior?: string
}

export async function upsertJobPolicy(input: UpsertJobPolicyInput) {
	const values = {
		jobType: input.jobType,
		maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		backoffMs: input.backoffMs ?? DEFAULT_BACKOFF_MS,
		concurrencyKey: input.concurrencyKey ?? null,
		concurrencyLimit: input.concurrencyLimit ?? null,
		timeoutMs: input.timeoutMs ?? 60_000,
		cancelBehavior: input.cancelBehavior ?? 'best_effort',
	}
	const [row] = await db
		.insert(jobPolicies)
		.values(values)
		.onConflictDoUpdate({
			target: jobPolicies.jobType,
			set: { ...values, updatedAt: new Date() },
		})
		.returning()
	return row
}
