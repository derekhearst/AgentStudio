import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
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
