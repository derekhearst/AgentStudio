import {
	boolean,
	index,
	integer,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 4 #15 phase 1 — Projects + Artifacts + Versions.
 *
 * Three tables that promote artifacts from "ephemeral SSE block in chat" to first-class
 * durable entities with stable IDs and append-only version history.
 *
 *   projects → containers a user creates ("efoil rebuild", "tax research")
 *   artifacts → named documents within a project (each has a current version pointer)
 *   artifactVersions → immutable per-edit snapshot; rollback = copy old seq forward
 *
 * Identity rules:
 *   - `(userId, slug)` is unique on projects so URLs are stable.
 *   - `(projectId, slug)` is unique on artifacts so each artifact has one stable name in
 *     its project.
 *   - `(artifactId, seq)` is unique on artifactVersions so the version number is the
 *     canonical "v3" UI label.
 *
 * The `currentVersionId` denormalization on artifacts gives O(1) latest-content lookup.
 * It's nullable because the chicken-and-egg between artifacts ↔ artifactVersions makes
 * the FK directionally awkward; the application always keeps it consistent and we rely on
 * `artifactVersions.artifactId` (with cascade) for delete integrity.
 */

export const projectKindEnum = pgEnum('project_kind', [
	'efoil',
	'research',
	'code',
	'documentation',
	'other',
])

export const artifactContentTypeEnum = pgEnum('artifact_content_type', [
	'markdown',
	'code',
	'json',
	'yaml',
	'plaintext',
])

export const projects = pgTable(
	'projects',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		description: text('description'),
		kind: projectKindEnum('kind').notNull().default('other'),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		userSlugUnique: unique('projects_user_slug_unique').on(t.userId, t.slug),
		userIdx: index('projects_user_idx').on(t.userId),
		kindIdx: index('projects_kind_idx').on(t.kind),
	}),
)

export const artifacts = pgTable(
	'artifacts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: uuid('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		contentType: artifactContentTypeEnum('content_type').notNull().default('markdown'),
		// Denormalized pointer to the most recent version. Application keeps this consistent;
		// nullable so the artifact row can be created BEFORE its first version (single
		// transaction in createArtifact).
		currentVersionId: uuid('current_version_id'),
		isActive: boolean('is_active').notNull().default(true),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		projectSlugUnique: unique('artifacts_project_slug_unique').on(t.projectId, t.slug),
		projectIdx: index('artifacts_project_idx').on(t.projectId),
		activeIdx: index('artifacts_active_idx').on(t.isActive),
	}),
)

export const artifactVersions = pgTable(
	'artifact_versions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		artifactId: uuid('artifact_id')
			.notNull()
			.references(() => artifacts.id, { onDelete: 'cascade' }),
		seq: integer('seq').notNull(),
		content: text('content').notNull(),
		changeNote: text('change_note'),
		// Null editor = produced by an agent (not a direct human edit). SET NULL on user delete
		// so the version row survives for compliance/audit.
		editedBy: uuid('edited_by').references(() => users.id, { onDelete: 'set null' }),
		// Optional link to the chat run that produced this edit (audit chain: version → run →
		// conversation). Declared by-name to avoid a chat_runs import cycle; SET NULL so a GC'd
		// run doesn't orphan the version.
		sourceRunId: uuid('source_run_id'),
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		artifactSeqUnique: unique('artifact_versions_artifact_seq_unique').on(t.artifactId, t.seq),
		artifactIdx: index('artifact_versions_artifact_idx').on(t.artifactId),
		createdIdx: index('artifact_versions_created_idx').on(t.createdAt),
	}),
)

export type ProjectRow = typeof projects.$inferSelect
export type ArtifactRow = typeof artifacts.$inferSelect
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect
export type ProjectKind = (typeof projectKindEnum.enumValues)[number]
export type ArtifactContentType = (typeof artifactContentTypeEnum.enumValues)[number]
