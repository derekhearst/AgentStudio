import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const agentStatusEnum = pgEnum('agent_status', ['active', 'paused', 'idle'])

export const agents = pgTable('agents', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	role: text('role').notNull(),
	systemPrompt: text('system_prompt').notNull(),
	model: text('model').notNull().default('anthropic/claude-sonnet-4'),
	config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
	status: agentStatusEnum('status').notNull().default('idle'),
	parentAgentId: uuid('parent_agent_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
