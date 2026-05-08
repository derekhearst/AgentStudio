import {
	boolean,
	check,
	index,
	integer,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from '$lib/auth/auth.schema'
import { conversations } from '$lib/sessions/sessions.schema'

/**
 * Projects + Artifacts + Versions.
 *
 * Three tables that promote artifacts from "ephemeral SSE block in chat" to first-class
 * durable entities with stable IDs and append-only version history.
 *
 *   projects → containers a user creates ("efoil rebuild", "tax research")
 *   artifacts → named documents bound to either a project OR a conversation
 *   artifactVersions → immutable per-edit snapshot; rollback = copy old seq forward
 *
 * Identity rules:
 *   - `(userId, slug)` is unique on projects so URLs are stable.
 *   - Artifacts are scoped to either a project or a conversation. Slug uniqueness is
 *     partial — `(project_id, slug)` when project-scoped, `(conversation_id, slug)`
 *     when conversation-scoped.
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

/**
 * Whether the project has a sandboxed git repo on disk, and where it came from.
 *
 *   'none'     — no filesystem footprint (legacy / database-only project)
 *   'local'    — `git init`'d at <SANDBOX_WORKSPACE>/<userId>/projects/<projectId>, no remote
 *   'imported' — cloned from a remote (GitHub / Azure / URL); paired with a `repositories` sidecar row
 *
 * Stored as a plain text column rather than an enum so adding a future kind (e.g. 'submodule')
 * doesn't require a migration of every existing row.
 */
export type RepoKind = 'none' | 'local' | 'imported'

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
		// Repo-shape fields. `repoKind='none'` means no fs footprint; 'local' = git init'd
		// at the project's sandbox path; 'imported' = cloned from a remote (paired with a
		// `repositories` sidecar row carrying provider/owner/name/cloneUrl).
		repoKind: text('repo_kind').notNull().default('none').$type<RepoKind>(),
		repoLocalPath: text('repo_local_path'),
		defaultBranch: text('default_branch'),
		lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }),
		lastImportedAt: timestamp('last_imported_at', { withTimezone: true }),
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
		// An artifact is scoped to either a project or a conversation. Exactly one of these
		// must be set (CHECK constraint). Project-scoped artifacts live in /projects;
		// conversation-scoped artifacts are the lightweight in-chat plan/todo/document.
		projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
		conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
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
		// Partial uniques so each scope has its own slug namespace.
		projectSlugUnique: uniqueIndex('artifacts_project_slug_unique')
			.on(t.projectId, t.slug)
			.where(sql`${t.projectId} is not null`),
		conversationSlugUnique: uniqueIndex('artifacts_conversation_slug_unique')
			.on(t.conversationId, t.slug)
			.where(sql`${t.conversationId} is not null`),
		projectIdx: index('artifacts_project_idx').on(t.projectId),
		conversationIdx: index('artifacts_conversation_idx').on(t.conversationId),
		activeIdx: index('artifacts_active_idx').on(t.isActive),
		scopeCheck: check(
			'artifacts_scope_check',
			sql`(${t.projectId} is not null) or (${t.conversationId} is not null)`,
		),
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
