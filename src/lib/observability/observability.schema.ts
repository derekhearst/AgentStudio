import {
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 5 #20 phase 1 — observability + review inbox foundation.
 *
 * Three tables for the unified human-and-machine control plane:
 *
 *   runTraces — normalized step timeline per chat_run for the trace viewer
 *   reviewItems — every action waiting on a human (approvals, eval failures, stuck jobs,
 *                 hook failures, artifact conflicts, memory conflicts, policy override
 *                 requests). One inbox, all sources.
 *   operationalMetrics — sampled point-in-time measurements (queue depth, tool latency,
 *                        retry rates) for the dashboard charts.
 *
 * Cross-domain pointers (runId, taskId, jobId, projectId, artifactId) are declared by-name
 * on reviewItems so the inbox can deep-link without circular schema imports. Application
 * logic enforces ownership at the read boundary; deletes in those domains don't cascade
 * here (review items survive their source row's GC for forensic visibility).
 */

export const runTraceStatusEnum = pgEnum('run_trace_status', [
	'running',
	'completed',
	'failed',
	'canceled',
])

export const reviewItemTypeEnum = pgEnum('review_item_type', [
	'approval_request',
	'user_question',
	'evaluation_failure',
	'job_failure',
	'job_stuck',
	'hook_failure',
	'artifact_conflict',
	'memory_conflict',
	'policy_override_request',
	// Wave 5 #19 phase 4 — agent successfully opened a pull request via `create_pull_request`.
	// Operator surfaces the PR in /review without monitoring chat; payload carries the PR
	// number, html url, and originating run id.
	'pull_request_ready',
	// Wave 5 #21 phase 4 (output routing) — maintenance-mode automation tick wrote its
	// summary to the review inbox via `outputTarget = review_inbox`. Payload carries the
	// automation id, mode, and a truncated summary.
	'automation_summary',
])

export const reviewItemStatusEnum = pgEnum('review_item_status', [
	'open',
	'in_progress',
	'resolved',
	'dismissed',
])

export const reviewItemSeverityEnum = pgEnum('review_item_severity', ['info', 'warning', 'critical'])

export const runTraces = pgTable(
	'run_traces',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// chat_run id — declared by-name to avoid a circular import with $lib/runs.
		runId: uuid('run_id').notNull(),
		sessionId: uuid('session_id'),
		taskId: uuid('task_id'),
		jobId: uuid('job_id'),
		// Normalized step timeline: array of {seq, kind, name, startedAt, durationMs, success?, payload?}.
		// The trace viewer renders this directly; runtime appends spans during the loop.
		trace: jsonb('trace').$type<Array<Record<string, unknown>>>().notNull().default([]),
		startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		status: runTraceStatusEnum('status').notNull().default('running'),
		// Aggregate counts pulled from the trace for quick display without parsing the jsonb.
		toolCallCount: integer('tool_call_count').notNull().default(0),
		roundCount: integer('round_count').notNull().default(0),
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }).notNull().default('0'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		runIdx: index('run_traces_run_idx').on(t.runId),
		statusIdx: index('run_traces_status_idx').on(t.status),
		startedIdx: index('run_traces_started_idx').on(t.startedAt),
	}),
)

export const reviewItems = pgTable(
	'review_items',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		type: reviewItemTypeEnum('type').notNull(),
		status: reviewItemStatusEnum('status').notNull().default('open'),
		severity: reviewItemSeverityEnum('severity').notNull().default('warning'),
		// Cross-domain pointers — all by-name, all nullable. The combination depends on item
		// type: approval_request has runId+sessionId; evaluation_failure has runId; job_failure
		// has jobId; artifact_conflict has projectId+artifactId; etc.
		runId: uuid('run_id'),
		sessionId: uuid('session_id'),
		taskId: uuid('task_id'),
		jobId: uuid('job_id'),
		projectId: uuid('project_id'),
		artifactId: uuid('artifact_id'),
		// Free-form payload: depends on type. For approval_request: { toolName, args, token }.
		// For evaluation_failure: { verdict, findings }. For artifact_conflict: { candidates }.
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		// One-line summary shown in the inbox without expanding the payload.
		summary: text('summary'),
		// Optional assignment to a specific user (when null, the item is in the shared queue).
		assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
		// Resolution audit. resolvedBy is the user who took action; resolution captures their
		// decision (approved/denied/dismissed/overridden + free-form note).
		resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
		resolution: jsonb('resolution').$type<{ action: string; note?: string }>(),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		typeStatusIdx: index('review_items_type_status_idx').on(t.type, t.status),
		statusSeverityIdx: index('review_items_status_severity_idx').on(t.status, t.severity),
		assignedIdx: index('review_items_assigned_idx').on(t.assignedTo),
		runIdx: index('review_items_run_idx').on(t.runId),
		taskIdx: index('review_items_task_idx').on(t.taskId),
		jobIdx: index('review_items_job_idx').on(t.jobId),
		createdIdx: index('review_items_created_idx').on(t.createdAt),
	}),
)

export const operationalMetrics = pgTable(
	'operational_metrics',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Metric name (e.g. "queue.depth", "tool.latency_ms.p95", "evaluator.cost_usd"). Free-form
		// text rather than enum so new metrics land without migrations.
		metric: text('metric').notNull(),
		// Per-metric dimensions: { queue: 'default' } or { type: 'memory_mine' } etc.
		dimension: jsonb('dimension').$type<Record<string, unknown>>().notNull().default({}),
		value: numeric('value', { precision: 18, scale: 6 }).notNull(),
		measuredAt: timestamp('measured_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		metricMeasuredIdx: index('operational_metrics_metric_measured_idx').on(t.metric, t.measuredAt),
		measuredIdx: index('operational_metrics_measured_idx').on(t.measuredAt),
	}),
)

export const logLevelEnum = pgEnum('log_level', ['debug', 'info', 'warn', 'error'])

export const appLogs = pgTable(
	'app_logs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Time the log line was emitted at the call site (not when persisted). The logger sets
		// this when the entry hits its in-memory buffer so batched flushes preserve ordering
		// even if writes lag.
		ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
		level: logLevelEnum('level').notNull(),
		// Message string — keeps the leading `[domain]` prefix the call sites already use so
		// the table reads like the existing console output. Indexed via trigram-style filter on
		// the read path; for now a plain BTREE on (level, ts) covers most queries.
		message: text('message').notNull(),
		// Optional structured context object — anything the call site passes as the second arg
		// to `logger.warn(message, context)`. Errors are normalized to `{ message, name, stack }`
		// before insert so a thrown Error doesn't serialize to `{}`.
		context: jsonb('context').$type<Record<string, unknown> | null>(),
		// Optional bracketed prefix lifted off the message (e.g. "automations" from
		// "[automations] budget block alert insert failed"). Indexed for fast per-domain filters.
		source: text('source'),
		// Optional userId, set when the log site has a request user in scope. Cascades to NULL
		// rather than delete so historical logs survive a user soft-delete.
		userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
	},
	(t) => ({
		// Default browse view: most recent first.
		tsIdx: index('app_logs_ts_idx').on(t.ts),
		// Per-level filter (warn/error views) ordered by recency.
		levelTsIdx: index('app_logs_level_ts_idx').on(t.level, t.ts),
		// Per-source filter for narrowing to a domain (e.g. "automations").
		sourceTsIdx: index('app_logs_source_ts_idx').on(t.source, t.ts),
	}),
)

export type RunTraceRow = typeof runTraces.$inferSelect
export type ReviewItemRow = typeof reviewItems.$inferSelect
export type OperationalMetricRow = typeof operationalMetrics.$inferSelect
export type AppLogRow = typeof appLogs.$inferSelect
export type ReviewItemType = (typeof reviewItemTypeEnum.enumValues)[number]
export type ReviewItemStatus = (typeof reviewItemStatusEnum.enumValues)[number]
export type ReviewItemSeverity = (typeof reviewItemSeverityEnum.enumValues)[number]
export type RunTraceStatus = (typeof runTraceStatusEnum.enumValues)[number]
export type LogLevel = (typeof logLevelEnum.enumValues)[number]
