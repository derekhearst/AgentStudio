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
 * Projects.
 *
 * A project is a durable container a user creates ("efoil rebuild", "tax research").
 * Everything the agent writes for a project is a real file in that project's sandbox
 * working directory — there is no document table here. `(userId, slug)` is unique so
 * project URLs are stable.
 *
 * This module used to also own `artifacts` + `artifact_versions`, which promoted
 * in-chat documents to versioned DB rows. That whole layer is gone: the filesystem
 * tools and git are the version history now.
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
 *   'imported' — cloned from a remote (GitHub or any clone URL); paired with a `repositories` sidecar row
 *
 * Stored as a plain text column rather than an enum so adding a future kind (e.g. 'submodule')
 * doesn't require a migration of every existing row.
 */
export type RepoKind = 'none' | 'local' | 'imported'

export const projects = pgTable(
	'projects',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		description: text('description'),
		kind: projectKindEnum('kind').notNull().default('other'),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
		// Repo-shape fields. `repoKind='none'` means no repository (the project's directory may
		// still hold knowledge files and what its chats wrote); 'local' = git init'd
		// at the project's sandbox path; 'imported' = cloned from a remote (paired with a
		// `repositories` sidecar row carrying provider/owner/name/cloneUrl).
		repoKind: text('repo_kind').notNull().default('none').$type<RepoKind>(),
		repoLocalPath: text('repo_local_path'),
		defaultBranch: text('default_branch'),
		/**
		 * Whether the operator has looked at this project's committed `.claude/` config and
		 * accepted it. Gates whether the run loads the repo's `CLAUDE.md`, commands and
		 * skills — and, inseparably, its `.claude/settings.json`, which can carry hooks and
		 * permission allow-rules. Default false: a cloned repo is not trusted because it was
		 * cloned. See `$lib/engine/setting-sources`.
		 */
		settingsTrusted: boolean('settings_trusted').notNull().default(false),
		/**
		 * Standing instructions for this project, written by the operator (#23).
		 *
		 * Deliberately *not* written out as a `CLAUDE.md` in the project's directory, which
		 * was the earlier plan. `CLAUDE.md` only loads when `settingSources` includes
		 * `'project'`, which is gated on `settingsTrusted` above — so routing the operator's
		 * own words through that file would make them silently vanish for any project whose
		 * repo config the operator has not accepted. Those are two different questions:
		 * "do I trust what this repo committed" and "here is what I want the agent to know".
		 * A repo's own `CLAUDE.md` still loads on the trusted path; this is the other one,
		 * and it goes through the project context slot, which is never gated.
		 */
		instructions: text('instructions'),
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

export type ProjectRow = typeof projects.$inferSelect
export type ProjectKind = (typeof projectKindEnum.enumValues)[number]
