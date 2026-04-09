import { integer, jsonb, numeric, pgEnum, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '../auth/auth.schema'
import { agents } from '../agents/agents.schema'

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool'])

export const conversations = pgTable('conversations', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: text('title').notNull(),
	category: text('category'),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
	agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
	model: text('model').notNull().default('anthropic/claude-sonnet-4'),
	totalTokens: integer('total_tokens').notNull().default(0),
	totalCost: numeric('total_cost', { precision: 18, scale: 12 }).notNull().default('0'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const messages = pgTable('messages', {
	id: uuid('id').primaryKey().defaultRandom(),
	conversationId: uuid('conversation_id')
		.notNull()
		.references(() => conversations.id, { onDelete: 'cascade' }),
	role: messageRoleEnum('role').notNull(),
	content: text('content').notNull(),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
	toolCalls: jsonb('tool_calls').$type<Array<Record<string, unknown>>>().notNull().default([]),
	attachments: jsonb('attachments')
		.$type<Array<{ id: string; filename: string; mimeType: string; size: number; url: string }>>()
		.notNull()
		.default([]),
	model: text('model'),
	tokensIn: integer('tokens_in').notNull().default(0),
	tokensOut: integer('tokens_out').notNull().default(0),
	cost: numeric('cost', { precision: 18, scale: 12 }).notNull().default('0'),
	ttftMs: integer('ttft_ms'),
	totalMs: integer('total_ms'),
	tokensPerSec: real('tokens_per_sec'),
	parentMessageId: uuid('parent_message_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
