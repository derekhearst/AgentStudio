import { boolean, integer, pgTable, text, timestamp, unique, uuid, vector } from 'drizzle-orm/pg-core'

export const skills = pgTable('skills', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull().unique(),
	description: text('description').notNull(),
	content: text('content').notNull(),
	tags: text('tags').array().notNull().default([]),
	enabled: boolean('enabled').notNull().default(true),
	accessCount: integer('access_count').notNull().default(0),
	lastAccessed: timestamp('last_accessed', { withTimezone: true }),
	// 1536-dim embedding of `name + ' — ' + description` for relevance-filtered injection
	// (Phase 4 of #4). Nullable so existing rows keep working until they get re-embedded.
	descriptionEmbedding: vector('description_embedding', { dimensions: 1536 }),
	descriptionEmbeddedAt: timestamp('description_embedded_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const skillFiles = pgTable(
	'skill_files',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		skillId: uuid('skill_id')
			.notNull()
			.references(() => skills.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		content: text('content').notNull(),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [unique().on(t.skillId, t.name)],
)
