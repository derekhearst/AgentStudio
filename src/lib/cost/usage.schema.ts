import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const llmUsage = pgTable('llm_usage', {
	id: uuid('id').primaryKey().defaultRandom(),
	source: text('source').notNull(), // 'chat' | 'agent_planner' | 'agent_synthesis' | 'titlegen' | 'memory_extract' | 'image_gen'
	model: text('model').notNull(),
	tokensIn: integer('tokens_in').notNull().default(0),
	tokensOut: integer('tokens_out').notNull().default(0),
	cost: numeric('cost', { precision: 18, scale: 12 }).notNull().default('0'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
