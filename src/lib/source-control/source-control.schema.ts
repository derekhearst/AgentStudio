import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 5 #19 phase 1 — source-control durable records.
 *
 * Five tables that move source-control from "scratch dir + ad-hoc shell" to first-class:
 *
 *   repositories — known repos the user has attached. URL + provider + default branch.
 *   repositoryConnections — provider auth state per (provider, user). Token, scopes,
 *                           status (active/error/revoked), last-sync timestamp.
 *   repositoryBranches — branches the system has created or knows about (default + agent-
 *                        created branches for tasks). Lightweight — full branch state lives
 *                        on the provider; this table is just an index for our UI.
 *   pullRequests — PRs the system created or attached, with link to the originating task
 *                  + run + provider PR number. Status mirrored from the provider.
 *   pullRequestChecks — CI check status per PR; one row per (prId, checkName).
 *
 * Cross-domain pointers (project_id, task_id, run_id) are declared by-name to avoid
 * circular schema imports. Application logic enforces ownership at the read boundary.
 */

export const sourceControlProviderEnum = pgEnum('source_control_provider', [
	'github',
	'gitlab',
	'bitbucket',
	'gitea',
	'azure_devops',
	'local',
])

export const sourceControlConnectionStatusEnum = pgEnum('source_control_connection_status', [
	'active',
	'error',
	'revoked',
	'pending',
])

export const pullRequestStatusEnum = pgEnum('pull_request_status', [
	'draft',
	'open',
	'merged',
	'closed',
])

export const pullRequestCheckStatusEnum = pgEnum('pull_request_check_status', [
	'pending',
	'running',
	'success',
	'failure',
	'canceled',
	'skipped',
])

export const repositories = pgTable(
	'repositories',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
		// Optional link to a project — when set, the project's runs default to this repo's
		// worktree mode. Declared by-name to avoid circular imports with $lib/projects.
		projectId: uuid('project_id'),
		provider: sourceControlProviderEnum('provider').notNull().default('github'),
		// Owner/org + repo name (e.g. "anthropics/claude-code").
		owner: text('owner').notNull(),
		name: text('name').notNull(),
		// Full clone URL — keeps SSH vs HTTPS choice flexible.
		cloneUrl: text('clone_url').notNull(),
		defaultBranch: text('default_branch').notNull().default('main'),
		// Free-form provider metadata (visibility, archived, fork status, etc.).
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		userOwnerNameUnique: unique('repositories_user_owner_name_unique').on(t.userId, t.owner, t.name),
		userIdx: index('repositories_user_idx').on(t.userId),
		projectIdx: index('repositories_project_idx').on(t.projectId),
		providerIdx: index('repositories_provider_idx').on(t.provider),
	}),
)

export const repositoryConnections = pgTable(
	'repository_connections',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		provider: sourceControlProviderEnum('provider').notNull(),
		// Account/login on the provider side (e.g. GitHub username).
		providerAccount: text('provider_account').notNull(),
		// Token storage — encrypted at the application boundary, never in plaintext logs.
		// Schema is just a text column; the application encrypts/decrypts at write/read time.
		encryptedToken: text('encrypted_token').notNull(),
		scopes: text('scopes').array().notNull().default([]),
		status: sourceControlConnectionStatusEnum('status').notNull().default('active'),
		lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
		// When status='error', the most recent error message for the admin viewer.
		lastError: text('last_error'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		userProviderAccountUnique: unique('repo_connections_user_provider_account_unique').on(
			t.userId,
			t.provider,
			t.providerAccount,
		),
		userIdx: index('repo_connections_user_idx').on(t.userId),
		statusIdx: index('repo_connections_status_idx').on(t.status),
	}),
)

export const repositoryBranches = pgTable(
	'repository_branches',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		repositoryId: uuid('repository_id')
			.notNull()
			.references(() => repositories.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		// Optional link to a task — set when an agent created the branch as part of a coding task.
		taskId: uuid('task_id'),
		// Optional link to the run that created the branch — for the audit chain.
		createdByRunId: uuid('created_by_run_id'),
		// SHA of the latest commit we know about (mirrored from provider).
		headSha: text('head_sha'),
		isDefault: boolean('is_default').notNull().default(false),
		// Provider state: 'open' / 'merged' / 'deleted' — when null, treated as 'open'.
		state: text('state'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		repoNameUnique: unique('repo_branches_repo_name_unique').on(t.repositoryId, t.name),
		repoIdx: index('repo_branches_repo_idx').on(t.repositoryId),
		taskIdx: index('repo_branches_task_idx').on(t.taskId),
	}),
)

export const pullRequests = pgTable(
	'pull_requests',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		repositoryId: uuid('repository_id')
			.notNull()
			.references(() => repositories.id, { onDelete: 'cascade' }),
		// Provider PR number (e.g. GitHub PR #123). Unique per repository.
		providerPrNumber: integer('provider_pr_number').notNull(),
		title: text('title').notNull(),
		body: text('body'),
		headBranch: text('head_branch').notNull(),
		baseBranch: text('base_branch').notNull(),
		status: pullRequestStatusEnum('status').notNull().default('draft'),
		// Cross-domain pointers — declared by-name. The PR record is the bridge between
		// repos + tasks + runs, so the audit chain reads task → PR → checks → review_items.
		taskId: uuid('task_id'),
		runId: uuid('run_id'),
		// User who created/triggered the PR — set-null on user delete so the audit chain survives.
		createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
		// Mirrored provider state.
		providerUrl: text('provider_url'),
		mergedAt: timestamp('merged_at', { withTimezone: true }),
		closedAt: timestamp('closed_at', { withTimezone: true }),
		// Free-form metadata (mergeable state, conflict state, behind-base flag, etc.).
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		repoPrNumberUnique: unique('pull_requests_repo_pr_number_unique').on(t.repositoryId, t.providerPrNumber),
		repoIdx: index('pull_requests_repo_idx').on(t.repositoryId),
		statusIdx: index('pull_requests_status_idx').on(t.status),
		taskIdx: index('pull_requests_task_idx').on(t.taskId),
		runIdx: index('pull_requests_run_idx').on(t.runId),
	}),
)

export const pullRequestChecks = pgTable(
	'pull_request_checks',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		pullRequestId: uuid('pull_request_id')
			.notNull()
			.references(() => pullRequests.id, { onDelete: 'cascade' }),
		// Check name (e.g. "ci/test", "lint", "deploy/preview"). One row per (prId, checkName).
		checkName: text('check_name').notNull(),
		status: pullRequestCheckStatusEnum('status').notNull().default('pending'),
		// Optional URL to the provider's check details page.
		detailsUrl: text('details_url'),
		// Free-form provider payload (build IDs, durations, etc.).
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		prCheckNameUnique: unique('pr_checks_pr_check_name_unique').on(t.pullRequestId, t.checkName),
		prIdx: index('pr_checks_pr_idx').on(t.pullRequestId),
		statusIdx: index('pr_checks_status_idx').on(t.status),
	}),
)

export type RepositoryRow = typeof repositories.$inferSelect
export type RepositoryConnectionRow = typeof repositoryConnections.$inferSelect
export type RepositoryBranchRow = typeof repositoryBranches.$inferSelect
export type PullRequestRow = typeof pullRequests.$inferSelect
export type PullRequestCheckRow = typeof pullRequestChecks.$inferSelect
export type SourceControlProvider = (typeof sourceControlProviderEnum.enumValues)[number]
export type ConnectionStatus = (typeof sourceControlConnectionStatusEnum.enumValues)[number]
export type PullRequestStatus = (typeof pullRequestStatusEnum.enumValues)[number]
export type PullRequestCheckStatus = (typeof pullRequestCheckStatusEnum.enumValues)[number]
