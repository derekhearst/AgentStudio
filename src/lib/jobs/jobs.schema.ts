import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 4 #17 phase 1 — durable job queue primitives.
 *
 * Three tables for a Postgres-backed queue:
 *
 *   jobs — the work item. Status lifecycle: pending → leased → running → completed/failed/
 *          canceled. `retry_wait` is set after a failure that's eligible for retry.
 *   jobPolicies — per-jobType retry/backoff/concurrency/timeout settings. Insert one row per
 *                 type to override defaults; otherwise the worker uses static defaults.
 *   jobLeases — append-only lease history. The active lease is the row with the highest
 *               heartbeatAt for a given jobId. When `expiresAt < now` the worker considers
 *               the lease stale and the job available for re-claim.
 *
 * `type` is text (not enum) so new job kinds can land without migrations. `status` IS an
 * enum because it's a small fixed lifecycle and the worker's claim query relies on it.
 *
 * `dedupeKey` provides idempotent enqueue — `(type, dedupeKey)` is unique when both are set,
 * so re-enqueueing the same logical work returns the existing row instead of creating a
 * duplicate. The application is responsible for choosing keys (e.g. `mine:conv:${id}`).
 *
 * Foreign keys to runs/tasks/sessions/projects are deliberately omitted at the schema level
 * to avoid cycles — these columns are pointers + the application keeps them consistent.
 */

export const jobStatusEnum = pgEnum('job_status', [
	'pending',
	'leased',
	'running',
	'retry_wait',
	'completed',
	'failed',
	'canceled',
])

export const jobs = pgTable(
	'jobs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		type: text('type').notNull(),
		status: jobStatusEnum('status').notNull().default('pending'),
		// Higher number = higher priority. Default 100 puts user-action jobs ahead of background.
		priority: integer('priority').notNull().default(100),
		queue: text('queue').notNull().default('default'),
		dedupeKey: text('dedupe_key'),
		scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow().notNull(),
		// Cached lease expiry — the active row in jobLeases is the source of truth, but the
		// worker's claim query reads this denormalized field for cheap WHERE filtering.
		leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		attemptCount: integer('attempt_count').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(3),
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		result: jsonb('result').$type<Record<string, unknown>>(),
		error: jsonb('error').$type<{ message: string; stack?: string }>(),
		// Cross-domain pointers — declared by-name so we don't introduce circular schema imports.
		// The application keeps these consistent; deletes in those domains don't cascade here
		// (jobs are kept for forensic visibility even after the source row is GC'd).
		runId: uuid('run_id'),
		taskId: uuid('task_id'),
		sessionId: uuid('session_id'),
		projectId: uuid('project_id'),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		// Index path the worker uses to claim the next job: filter by status, sort by priority
		// desc + scheduled_at asc (older jobs first within the same priority bucket).
		claimIdx: index('jobs_claim_idx').on(t.status, t.scheduledAt, t.priority),
		queueIdx: index('jobs_queue_idx').on(t.queue, t.status),
		typeIdx: index('jobs_type_idx').on(t.type, t.status),
		runIdx: index('jobs_run_idx').on(t.runId),
		taskIdx: index('jobs_task_idx').on(t.taskId),
		userIdx: index('jobs_user_idx').on(t.userId),
		// Idempotency — `(type, dedupeKey)` is the natural unique key for enqueue dedupe. NULL
		// dedupeKey is allowed (multiple times) since most ad-hoc jobs don't need it.
		dedupeUnique: unique('jobs_type_dedupe_unique').on(t.type, t.dedupeKey),
	}),
)

export const jobPolicies = pgTable(
	'job_policies',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		jobType: text('job_type').notNull().unique(),
		maxAttempts: integer('max_attempts').notNull().default(3),
		backoffMs: integer('backoff_ms').notNull().default(5000),
		// Optional concurrency lock — when set, only `concurrencyLimit` jobs with the same
		// `concurrencyKey` may run simultaneously. Used for rate-limiting expensive job types.
		concurrencyKey: text('concurrency_key'),
		concurrencyLimit: integer('concurrency_limit'),
		timeoutMs: integer('timeout_ms').notNull().default(60_000),
		cancelBehavior: text('cancel_behavior').notNull().default('best_effort'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
)

export const jobLeases = pgTable(
	'job_leases',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		jobId: uuid('job_id')
			.notNull()
			.references(() => jobs.id, { onDelete: 'cascade' }),
		workerId: text('worker_id').notNull(),
		heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).defaultNow().notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		jobIdx: index('job_leases_job_idx').on(t.jobId),
		expiresIdx: index('job_leases_expires_idx').on(t.expiresAt),
	}),
)

export type JobRow = typeof jobs.$inferSelect
export type JobPolicyRow = typeof jobPolicies.$inferSelect
export type JobLeaseRow = typeof jobLeases.$inferSelect
export type JobStatus = (typeof jobStatusEnum.enumValues)[number]
