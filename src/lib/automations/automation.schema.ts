import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'

export const automationConversationModeEnum = pgEnum('automation_conversation_mode', ['new_each_run', 'reuse'])

/**
 * Wave 5 #21 phase 3 — automation execution mode.
 *
 * - chat_followup: legacy behavior — append the prompt into a chat conversation and run
 *   the model inline. Default for migrated automations to preserve back-compat.
 * - research: launch a research run with optional repository / project context.
 * - code: launch a coding workflow against a repo-backed project; respects review gates.
 * - maintenance: scheduled hygiene work (gc, cleanup, audit) with no chat surface.
 *
 * Phase 3 lands the enum + column. Phase 4 wires per-mode handlers; phase 5 wires output
 * routing + budget caps.
 */
export const automationModeEnum = pgEnum('automation_mode', ['chat_followup', 'research', 'code', 'maintenance'])

/**
 * Wave 5 #21 phase 3 — output routing target. Where the automation's output lands when the
 * run completes. Phase 4 implements the per-target write (e.g. open a review item for the
 * review_inbox target). Default 'chat_session' preserves current behavior.
 */
export const automationOutputTargetEnum = pgEnum('automation_output_target', [
	'chat_session',
	'task',
	'artifact',
	'review_inbox',
])

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
		prompt: text('prompt').notNull(),
		enabled: boolean('enabled').notNull().default(true),
		conversationMode: automationConversationModeEnum('conversation_mode').notNull().default('new_each_run'),
		conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
		// Wave 5 #21 phase 3 — execution mode + output target. Mode dispatches the handler;
		// outputTarget controls where the result lands. See enum docs above.
		mode: automationModeEnum('mode').notNull().default('chat_followup'),
		outputTarget: automationOutputTargetEnum('output_target').notNull().default('chat_session'),
		// Wave 5 #21 phase 4 finish — code-mode target repository. When mode='code', the
		// runner creates a task carrying this repository_id forward so the task runner
		// provisions a per-attempt worktree against the connected repo. Declared by-name
		// (no enforced FK); a deleted repo leaves the automation pointing at a stale id
		// that the runner detects + falls back from with a clear log.
		repositoryId: uuid('repository_id'),
		lastRunAt: timestamp('last_run_at', { withTimezone: true }),
		nextRunAt: timestamp('next_run_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		modeIdx: index('automations_mode_idx').on(t.mode),
		repositoryIdx: index('automations_repository_idx').on(t.repositoryId),
	}),
)

export type AutomationRow = typeof automations.$inferSelect
export type AutomationMode = (typeof automationModeEnum.enumValues)[number]
export type AutomationOutputTarget = (typeof automationOutputTargetEnum.enumValues)[number]
