import {
	boolean,
	index,
	integer,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'

export const automationConversationModeEnum = pgEnum('automation_conversation_mode', ['new_each_run', 'reuse'])

/**
 * Automation execution mode.
 *
 * - chat_followup: append the prompt into a chat conversation and run the model inline.
 * - research: launch a research run with optional repository / project context.
 * - maintenance: scheduled hygiene work (gc, cleanup, audit) with no chat surface.
 */
export const automationModeEnum = pgEnum('automation_mode', ['chat_followup', 'research', 'maintenance'])

/**
 * Output routing target. Where the automation's output lands when the run completes.
 */
export const automationOutputTargetEnum = pgEnum('automation_output_target', [
	'chat_session',
	'review_inbox',
])

/**
 * Why an automation is currently switched off. Deliberately NOT a pg enum — it is a small
 * open-ended label, and text keeps future reasons (budget, missing agent, …) migration-free.
 */
export type AutomationDisabledReason = 'consecutive_failures'

/** Lifecycle of one attempt at executing an automation. */
export type AutomationRunStatus = 'running' | 'completed' | 'failed' | 'blocked'

/**
 * What kicked the run off: the scheduler, a human pressing "Run now", or a monitor that
 * fired. Stored as text, so a new value needs no migration. What each may do is decided in
 * `automationTriggerPolicy` (failure-policy.ts).
 */
export type AutomationRunTrigger = 'schedule' | 'manual' | 'monitor'

export const automations = pgTable(
	'automations',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
		description: text('description').notNull(),
		cronExpression: text('cron_expression').notNull(),
		// #30 — a cron expression is a wall-clock schedule and means nothing without a zone.
		// The container sets no TZ, so before this column "9am" was resolved as UTC (3am in
		// Boise). IANA zone name; the default matches where the box and its operator live.
		timezone: text('timezone').notNull().default('America/Boise'),
		prompt: text('prompt').notNull(),
		enabled: boolean('enabled').notNull().default(true),
		conversationMode: automationConversationModeEnum('conversation_mode').notNull().default('new_each_run'),
		conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
		// Wave 5 #21 phase 3 — execution mode + output target. Mode dispatches the handler;
		// outputTarget controls where the result lands. See enum docs above.
		mode: automationModeEnum('mode').notNull().default('chat_followup'),
		outputTarget: automationOutputTargetEnum('output_target').notNull().default('chat_session'),
		repositoryId: uuid('repository_id'),
		lastRunAt: timestamp('last_run_at', { withTimezone: true }),
		nextRunAt: timestamp('next_run_at', { withTimezone: true }),
		// #31 — how many scheduled ticks have failed back-to-back (a tick counts once, after
		// its retries are exhausted). Reset to 0 by any successful run. When it crosses
		// AUTOMATION_DISABLE_AFTER_FAILURES the engine flips `enabled` off and stamps
		// `disabledReason` so a permanently broken automation stops burning budget.
		consecutiveFailures: integer('consecutive_failures').notNull().default(0),
		// Why the row is disabled. NULL = the user turned it off (or it was never on).
		// 'consecutive_failures' = the system turned it off; the UI must not present the two
		// the same way, because one of them is a bug report.
		disabledReason: text('disabled_reason').$type<AutomationDisabledReason | null>(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		modeIdx: index('automations_mode_idx').on(t.mode),
		repositoryIdx: index('automations_repository_idx').on(t.repositoryId),
	}),
)

/**
 * #31 — one row per attempt at executing an automation.
 *
 * Why a table and not a join over `chat_runs`: a chat_run only exists for the
 * agent-attached `chat_followup` path. Maintenance ticks, research ticks, the no-agent
 * synthesis path and every failure *before* the mode handler is reached (budget block,
 * missing agent, bad cron) produce no chat_run at all, so a join can only ever show a
 * subset of runs — and never the interesting ones, which are the failures. This table is
 * the run ledger; the mode-specific artifacts (`chatRunId`, `conversationId`,
 * `researchId`) are pointers out of it.
 *
 * Cross-domain pointers are declared by-name (no FK) to avoid circular schema imports,
 * matching the convention in `jobs.schema.ts`. Rows are pruned on age by the dispatch tick.
 */
export const automationRuns = pgTable(
	'automation_runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		automationId: uuid('automation_id')
			.notNull()
			.references(() => automations.id, { onDelete: 'cascade' }),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
		status: text('status').$type<AutomationRunStatus>().notNull().default('running'),
		trigger: text('trigger').$type<AutomationRunTrigger>().notNull().default('schedule'),
		// 1-based. >1 means this is a retry of a failed tick (see failure-policy.ts).
		attempt: integer('attempt').notNull().default(1),
		// Snapshot of the automation's mode at execution time — the row may be edited later.
		mode: text('mode').notNull().default('chat_followup'),
		startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		durationMs: integer('duration_ms'),
		// Where the output landed, so the UI can link straight to it.
		conversationId: uuid('conversation_id'),
		chatRunId: uuid('chat_run_id'),
		researchId: uuid('research_id'),
		jobId: uuid('job_id'),
		costUsd: numeric('cost_usd', { precision: 18, scale: 12 }),
		error: text('error'),
		/** First ~2k characters of whatever the run produced — enough to see it worked. */
		outputExcerpt: text('output_excerpt'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		automationIdx: index('automation_runs_automation_idx').on(t.automationId, t.startedAt),
		statusIdx: index('automation_runs_status_idx').on(t.status),
		startedIdx: index('automation_runs_started_idx').on(t.startedAt),
	}),
)

export type AutomationRow = typeof automations.$inferSelect
export type AutomationRunRow = typeof automationRuns.$inferSelect
export type AutomationMode = (typeof automationModeEnum.enumValues)[number]
export type AutomationOutputTarget = (typeof automationOutputTargetEnum.enumValues)[number]
