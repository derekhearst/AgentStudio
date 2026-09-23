import { and, asc, desc, eq, gte, inArray, isNotNull, lte, notExists, sql as drizzleSql, type SQLWrapper } from 'drizzle-orm'
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
 *     when the worker actually starts the work via beginJob). Also reclaims a `leased` OR
 *     `running` job whose lease has lapsed — its worker died — or, when that job has no
 *     attempts left or lapsed too long ago, fails it instead (see `claimNextJob`)
 *   - beginJob → status='running', startedAt set, attemptCount += 1
 *   - heartbeatJob → extends lease + updates lease row's heartbeatAt
 *   - completeJob → status='completed', finishedAt set, result stored
 *   - failJob → if attemptCount < maxAttempts: status='retry_wait' + scheduledAt = now+backoff;
 *               else: status='failed', finishedAt set, error stored
 *   - heartbeat, complete and fail only touch a job that is still leased/running, so a late
 *     report from a worker that lost the job cannot undo a cancel or a retirement
 *   - cancelJob → status='canceled' (cooperative; worker checks at safe boundaries). Canceled
 *     is final: the handler of a job canceled mid-run still returns or throws afterwards, and
 *     the in-flight guard above keeps that report from completing it or queuing a retry
 */

// ─────────── Enqueue ───────────

const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 5_000
const DEFAULT_QUEUE = 'default'

/**
 * The statuses in which a job is still queued or in flight. `(type, dedupeKey)` is unique
 * across exactly these rows — the partial index `jobs_type_dedupe_active_uidx` in
 * jobs.schema.ts spells out the same list, and the two must agree.
 */
export const ACTIVE_JOB_STATUSES = ['pending', 'leased', 'running', 'retry_wait'] as const satisfies readonly JobStatus[]

export type EnqueueJobInput = {
	type: string
	payload?: Record<string, unknown>
	priority?: number
	queue?: string
	dedupeKey?: string
	/**
	 * How long `dedupeKey` holds. Ignored when there is no key.
	 *
	 *   'active' (default) — collapse onto a job with the same key that is still queued or
	 *     running. Once that job finishes the key is free again, so a recurring enqueue with a
	 *     fixed key gets a fresh job each time: the dispatch ticks, memory mining.
	 *   'forever' — collapse onto ANY job ever enqueued with the key, whatever its status.
	 *     For work that must happen at most once: one run per automation slot, one evaluation
	 *     per chat run, one sample per metrics window. The index cannot express this, so it
	 *     is a read before the insert: two enqueues racing a job that finishes in between can
	 *     still produce two jobs, but never two in flight at once.
	 */
	dedupeScope?: 'active' | 'forever'
	scheduledAt?: Date
	maxAttempts?: number
	runId?: string | null
	sessionId?: string | null
	projectId?: string | null
	userId?: string | null
}

export type EnqueueJobOutcome = {
	job: JobRow
	/** False when the enqueue collapsed onto an existing job with the same dedupe key. */
	created: boolean
}

/**
 * Enqueue a new job. When `dedupeKey` is set and a job with the same `(type, dedupeKey)` is
 * still active — or, with `dedupeScope: 'forever'`, has ever existed — returns that EXISTING
 * row instead of creating a duplicate (idempotency contract).
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<JobRow> {
	return (await enqueueJobWithOutcome(input)).job
}

/** `enqueueJob`, plus whether a row was actually inserted — for callers that count work. */
export async function enqueueJobWithOutcome(input: EnqueueJobInput): Promise<EnqueueJobOutcome> {
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

	const dedupeKey = input.dedupeKey
	if (!dedupeKey) {
		const [row] = await db.insert(jobs).values(insertValues).returning()
		return { job: row, created: true }
	}

	if (input.dedupeScope === 'forever') {
		const existing = await findJobByDedupeKey(input.type, dedupeKey, { activeOnly: false })
		if (existing) return { job: existing, created: false }
	}

	// INSERT … ON CONFLICT DO NOTHING against the partial unique index, then read back the
	// active row it collided with. That row can finish in the gap between the two statements,
	// leaving nothing active to return — at which point the key is free, so insert again.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const inserted = await db.insert(jobs).values(insertValues).onConflictDoNothing().returning()
		if (inserted.length > 0) return { job: inserted[0], created: true }
		const active = await findJobByDedupeKey(input.type, dedupeKey, { activeOnly: true })
		if (active) return { job: active, created: false }
	}
	throw new Error(`enqueueJob: dedupe collision but no active row found — type=${input.type} dedupeKey=${dedupeKey}`)
}

/**
 * Give a running job's dedupe key back before the job finishes, so the next enqueue with that
 * key queues a fresh job instead of folding into this one. The key is kept on the row with the
 * job's id appended, so `/settings/jobs` still shows what the job was for.
 *
 * For catch-up work — "mine whatever this conversation has that is not mined yet". Such a job
 * reads its input when it starts, so an enqueue that folds into it after that point is lost
 * unless the job looks again before it lets go. `unlessExists` is that second look: while the
 * subquery finds rows the key is kept, this returns false, and the caller does another pass.
 *
 * The look has to be taken after new enqueues can no longer fold in unseen, so the transaction
 * first writes the job row. From then until commit, an enqueue's insert that collides with the
 * key waits for this transaction (Postgres checks a unique index against rows other
 * transactions are changing, and waits for them), then either finds the key released and gets
 * a job of its own, or finds it kept and folds into a job that is about to look again. An
 * enqueue that collided before the write committed its input before that, and the next
 * statement's fresh snapshot — READ COMMITTED takes one per statement — sees it.
 *
 * Returns true when the key was released, or when the job had none to release.
 */
export async function releaseDedupeKey(jobId: string, opts: { unlessExists?: SQLWrapper } = {}): Promise<boolean> {
	return db.transaction(async (tx) => {
		const held = await tx
			.update(jobs)
			.set({ updatedAt: new Date() })
			.where(and(eq(jobs.id, jobId), isNotNull(jobs.dedupeKey)))
			.returning({ id: jobs.id })
		if (held.length === 0) return true
		const released = await tx
			.update(jobs)
			.set({ dedupeKey: drizzleSql`${jobs.dedupeKey} || '#' || ${jobs.id}` })
			.where(and(eq(jobs.id, jobId), opts.unlessExists ? notExists(opts.unlessExists) : undefined))
			.returning({ id: jobs.id })
		return released.length > 0
	})
}

/** Newest job with this `(type, dedupeKey)`, optionally only among the active ones. */
async function findJobByDedupeKey(
	type: string,
	dedupeKey: string,
	opts: { activeOnly: boolean },
): Promise<JobRow | null> {
	const [row] = await db
		.select()
		.from(jobs)
		.where(
			and(
				eq(jobs.type, type),
				eq(jobs.dedupeKey, dedupeKey),
				opts.activeOnly ? inArray(jobs.status, [...ACTIVE_JOB_STATUSES]) : undefined,
			),
		)
		.orderBy(desc(jobs.createdAt))
		.limit(1)
	return row ?? null
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
 * A `running` job whose lease lapsed longer ago than this is failed, not resumed. Its worker
 * died mid-handler; picking the job up minutes later is what the lease is for, but a job a
 * dev server left behind last week — an automation run, a research run, a PR fix — would
 * otherwise re-run against a world that has moved on the first time a worker comes up.
 */
const ABANDONED_LEASE_MS = 60 * 60_000

/** Dead `running` jobs one claim call may retire before it gives up looking for real work. */
const MAX_RETIRED_PER_CLAIM = 5

type ClaimCandidate = {
	id: string
	status: JobStatus
	attempt_count: number
	max_attempts: number
	/** Seconds since the lease lapsed, by the database clock; null when there is no lease. */
	lease_lapsed_seconds: number | null
}

export type StaleRunningJobVerdict = {
	/**
	 * `abandoned` — the lease lapsed over an hour ago: leftovers from a process that went away
	 * long before this one came up. `out_of_attempts` — it died recently on its last attempt:
	 * a live crash loop, worth a human's attention.
	 */
	outcome: 'abandoned' | 'out_of_attempts'
	reason: string
}

/**
 * What to do with a candidate whose lease lapsed while it was `running`: its handler started
 * (beginJob already counted the attempt) and then the worker stopped heartbeating, which in
 * practice means the process died — a deploy, a crash, an OOM. Out of attempts means the
 * handler probably IS what kills the process, so re-leasing it would crash the next worker
 * too. Returns null to re-lease, or why to fail it.
 */
export function staleRunningJobVerdict(job: {
	attemptCount: number
	maxAttempts: number
	leaseLapsedMs: number
}): StaleRunningJobVerdict | null {
	if (job.leaseLapsedMs > ABANDONED_LEASE_MS) {
		return {
			outcome: 'abandoned',
			reason: `The worker running this job stopped heartbeating ${Math.round(job.leaseLapsedMs / 60_000)} minutes ago — too long ago to resume it safely.`,
		}
	}
	if (job.attemptCount >= job.maxAttempts) {
		return {
			outcome: 'out_of_attempts',
			reason: `The worker running this job stopped heartbeating on attempt ${job.attemptCount} of ${job.maxAttempts}, and no attempts are left.`,
		}
	}
	return null
}

/**
 * Atomic claim of the next eligible job. Uses `FOR UPDATE SKIP LOCKED` so concurrent workers
 * don't fight over the same row. Returns null when no job is available.
 *
 * Eligible:
 *   status IN (pending, retry_wait) AND scheduled_at <= now()
 *   OR status IN (leased, running) AND lease_expires_at < now() (its worker died)
 *
 * A lapsed `leased` job never started, so it is simply re-leased. A lapsed `running` job
 * started and then lost its worker mid-handler; it is re-leased too — beginJob counts the
 * new attempt — unless `staleRunningJobVerdict` says to fail it, in which case it is failed
 * (with a `job_stuck` review item when it is a live crash loop) and the claim looks again.
 * Before `running` was eligible
 * here, a job whose worker died mid-handler stayed `running` forever, and for automations
 * that wedged the schedule: every tick's enqueue collided with the dead row.
 *
 * Ordering: priority desc, scheduled_at asc (oldest within priority first).
 */
export async function claimNextJob(opts: ClaimJobOptions): Promise<JobRow | null> {
	for (let retired = 0; retired <= MAX_RETIRED_PER_CLAIM; retired += 1) {
		const outcome = await claimOnce(opts)
		if (outcome.kind === 'claimed') return outcome.job
		if (outcome.kind === 'empty') return null
		await reportRetiredJob(outcome.job, outcome.verdict)
	}
	return null
}

type ClaimOutcome =
	| { kind: 'claimed'; job: JobRow }
	| { kind: 'retired'; job: JobRow; verdict: StaleRunningJobVerdict }
	| { kind: 'empty' }

async function claimOnce(opts: ClaimJobOptions): Promise<ClaimOutcome> {
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
	const outcome = await db.transaction(async (tx): Promise<ClaimOutcome> => {
		const candidateText = `
			select id, status, attempt_count, max_attempts,
				extract(epoch from (now() - lease_expires_at))::float8 as lease_lapsed_seconds
			from jobs
			where (
				(status in ('pending'::job_status, 'retry_wait'::job_status) and scheduled_at <= now())
				or (status in ('leased'::job_status, 'running'::job_status) and lease_expires_at < now())
			)
			${queueClause}
			${typeClause}
			order by priority desc, scheduled_at asc
			limit 1
			for update skip locked
		`
		const candidateResult = await tx.execute(drizzleSql.raw(candidateText))
		const candidateRows = (candidateResult as unknown as { rows?: ClaimCandidate[] }).rows
			?? (candidateResult as unknown as ClaimCandidate[])
		const candidate = Array.isArray(candidateRows) ? candidateRows[0] : null
		if (!candidate) return { kind: 'empty' }

		// The lapse is computed in SQL: this client returns timestamps as raw strings, and the
		// candidate filter above already judged "lapsed" by the database clock.
		if (candidate.status === 'running' && candidate.lease_lapsed_seconds !== null) {
			const verdict = staleRunningJobVerdict({
				attemptCount: Number(candidate.attempt_count),
				maxAttempts: Number(candidate.max_attempts),
				leaseLapsedMs: Number(candidate.lease_lapsed_seconds) * 1000,
			})
			if (verdict) {
				const [failed] = await tx
					.update(jobs)
					.set({
						status: 'failed',
						finishedAt: new Date(),
						leaseExpiresAt: null,
						error: { message: verdict.reason },
						updatedAt: new Date(),
					})
					.where(eq(jobs.id, candidate.id))
					.returning()
				return failed ? { kind: 'retired', job: failed, verdict } : { kind: 'empty' }
			}
		}

		const [updated] = await tx
			.update(jobs)
			.set({ status: 'leased', leaseExpiresAt: newLeaseExpiresAt, updatedAt: new Date() })
			.where(eq(jobs.id, candidate.id))
			.returning()
		return updated ? { kind: 'claimed', job: updated } : { kind: 'empty' }
	})

	if (outcome.kind !== 'claimed') return outcome
	const now = new Date()

	// Insert the lease record so the audit history shows what worker has the job.
	await db.insert(jobLeases).values({
		jobId: outcome.job.id,
		workerId: opts.workerId,
		heartbeatAt: now,
		expiresAt: newLeaseExpiresAt,
	})

	return outcome
}

/**
 * A crash loop gets the same visibility as a job that exhausted its retries: a review item
 * and a lifecycle metric. An abandoned job gets the metric and a log line but no review item —
 * the first boot after a long gap can retire dozens of them at once (a development database
 * collects one every time the dev server restarts mid-job), and an inbox row apiece would
 * bury anything real. Their `error` in /settings/jobs says what happened. Best-effort, like
 * `failJob`'s.
 */
async function reportRetiredJob(row: JobRow, verdict: StaleRunningJobVerdict): Promise<void> {
	void emitJobLifecycleMetric(row, 'failed')
	if (verdict.outcome === 'abandoned') {
		logger.info('[jobs] failed a long-abandoned running job', { jobId: row.id, type: row.type, reason: verdict.reason })
		return
	}
	const reason = verdict.reason
	logger.warn('[jobs] failed a running job whose worker kept dying', { jobId: row.id, type: row.type, reason })
	try {
		const { openReviewItem } = await import('$lib/observability/review.server')
		await openReviewItem({
			type: 'job_stuck',
			severity: 'warning',
			summary: `Job ${row.type} lost its worker mid-run and was failed: ${reason.slice(0, 160)}`,
			payload: {
				jobType: row.type,
				attemptCount: row.attemptCount,
				maxAttempts: row.maxAttempts,
				error: { message: reason },
			},
			runId: row.runId,
			jobId: row.id,
			dedupeKey: `job:${row.id}`,
		})
	} catch (err) {
		logger.warn('[jobs] review item open failed (non-fatal)', { err })
	}
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
 * The statuses a job has while a worker holds it. A worker's heartbeat and its final report
 * only apply to a job still in one of them.
 *
 * Reclaiming lapsed leases makes the queue at-least-once: a worker whose heartbeats stalled —
 * a database outage longer than the lease — can still be running a job that another worker
 * has since re-run, or that the claim path retired as failed. Without this guard its late
 * report overwrote whatever happened meanwhile: a retired job flipped to `completed`, a
 * canceled one to `completed`, or back into `retry_wait` to run again.
 */
const IN_FLIGHT_STATUSES = ['leased', 'running'] as const satisfies readonly JobStatus[]

/**
 * Extend the active lease + update the lease row's heartbeatAt. Workers should call this every
 * (leaseTtlMs / 3) or so to keep the lease fresh. Returns null — telling the worker to stop —
 * when the job is gone or no longer in flight: canceled, or retired by another worker.
 */
export async function heartbeatJob(jobId: string, leaseTtlMs?: number): Promise<JobRow | null> {
	const ttl = leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
	const newExpiry = new Date(Date.now() + ttl)
	const [row] = await db
		.update(jobs)
		.set({ leaseExpiresAt: newExpiry, updatedAt: new Date() })
		.where(and(eq(jobs.id, jobId), inArray(jobs.status, [...IN_FLIGHT_STATUSES])))
		.returning()
	if (!row) return null
	// Update the most recent lease row's heartbeat. Best-effort — the cached lease_expires_at
	// on jobs is the source of truth for the claim path.
	//
	// The expiry is bound as an ISO string with an explicit cast. Drizzle's postgres-js driver
	// switches off postgres.js's own Date serialisation (columns convert Dates themselves), so
	// a bare Date in a raw template reaches the wire unconverted and the query throws — which
	// made every heartbeat fail.
	await db.execute(drizzleSql`
		update job_leases
		set heartbeat_at = now(), expires_at = ${newExpiry.toISOString()}::timestamptz
		where job_id = ${jobId}
		and id = (select id from job_leases where job_id = ${jobId} order by heartbeat_at desc limit 1)
	`)
	return row
}

// ─────────── Terminal transitions ───────────

/** Returns null, changing nothing, when the job is no longer in flight (see IN_FLIGHT_STATUSES). */
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
		.where(and(eq(jobs.id, jobId), inArray(jobs.status, [...IN_FLIGHT_STATUSES])))
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
 * future `scheduledAt`. Otherwise transitions to terminal `failed`. Returns null, changing
 * nothing, when the job is no longer in flight (see IN_FLIGHT_STATUSES) — a canceled job whose
 * handler then threw must not be queued to run again.
 */
export async function failJob(jobId: string, opts: FailJobOptions): Promise<JobRow | null> {
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
	if (!job) return null
	const inFlight = and(eq(jobs.id, jobId), inArray(jobs.status, [...IN_FLIGHT_STATUSES]))

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
			.where(inFlight)
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
		.where(inFlight)
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
 * Find jobs whose lease has expired without a recent heartbeat — claimed or running on a
 * worker that has since died. `claimNextJob` recovers these on its own; this is for
 * inspection.
 */
export async function findStaleLeases(now = new Date()): Promise<JobRow[]> {
	return db
		.select()
		.from(jobs)
		.where(and(inArray(jobs.status, ['leased', 'running']), lte(jobs.leaseExpiresAt, now)))
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
