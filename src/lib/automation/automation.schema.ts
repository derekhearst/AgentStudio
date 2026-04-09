import { boolean, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/chat/chat.schema'

export const automationConversationModeEnum = pgEnum('automation_conversation_mode', ['new_each_run', 'reuse'])

export const automations = pgTable('automations', {
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
	lastRunAt: timestamp('last_run_at', { withTimezone: true }),
	nextRunAt: timestamp('next_run_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
