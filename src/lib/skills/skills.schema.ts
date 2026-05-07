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
	// Wave 2 #9 Phase 1 — tool-to-skill mapping for progressive disclosure of usage guidance.
	// `companionGroups` lists capability group names this skill teaches (e.g. ['sandbox']).
	// `companionTools` lists specific tool names this skill teaches (e.g. ['shell', 'file_patch']).
	// When the run enables a matching group, the skill's summary is auto-loaded as a context slot.
	companionGroups: text('companion_groups').array().notNull().default([]),
	companionTools: text('companion_tools').array().notNull().default([]),
	// PR-3 — skill category (tool/workflow/domain/policy/identity/hook). Nullable text
	// rather than a Postgres enum so we can iterate the set via Zod without enum migrations.
	// Backfilled from the `name` namespace in migration 0054.
	category: text('category'),
	// PR-3 — absolute path to the SKILL.md file that seeded this row, set by the repo file
	// boot loader (PR-4). NULL means "originated from the UI / DB seed". Used to distinguish
	// operator edits from disk-sourced rows.
	sourceFile: text('source_file'),
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
