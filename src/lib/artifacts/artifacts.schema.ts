import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { conversations, messages } from '../chat/chat.schema'

export const artifactTypeEnum = pgEnum('artifact_type', [
	'markdown',
	'code',
	'config',
	'image',
	'svg',
	'mermaid',
	'html',
	'svelte',
	'data_table',
	'chart',
	'audio',
	'video',
])

export const artifacts = pgTable('artifacts', {
	id: uuid('id').primaryKey().defaultRandom(),
	type: artifactTypeEnum('type').notNull(),
	title: text('title').notNull(),
	content: text('content').notNull().default(''),
	language: text('language'),
	mimeType: text('mime_type'),
	url: text('url'),
	category: text('category'),
	tags: jsonb('tags').$type<string[]>().notNull().default([]),
	storage: jsonb('storage').$type<Record<string, unknown>>().notNull().default({}),
	conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
	messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
	pinned: boolean('pinned').notNull().default(false),
	accessCount: integer('access_count').notNull().default(0),
	lastAccessed: timestamp('last_accessed', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const artifactVersions = pgTable('artifact_versions', {
	id: uuid('id').primaryKey().defaultRandom(),
	artifactId: uuid('artifact_id')
		.notNull()
		.references(() => artifacts.id, { onDelete: 'cascade' }),
	version: integer('version').notNull(),
	content: text('content').notNull(),
	language: text('language'),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
