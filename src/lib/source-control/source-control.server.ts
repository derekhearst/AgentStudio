import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	pullRequestChecks,
	pullRequests,
	repositories,
	repositoryBranches,
	repositoryConnections,
	type PullRequestRow,
	type PullRequestStatus,
	type RepositoryConnectionRow,
	type RepositoryRow,
	type SourceControlProvider,
} from './source-control.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { decryptSecret } from './encryption.server'
import {
	GithubApiError,
	listAuthenticatedUserRepos,
	type GithubRepoSummary,
} from './github-api.server'
import {
	AzureDevOpsApiError,
	listAzureAccounts,
	listAzureRepositoriesForOrg,
	type AzureRepoSummary,
} from './azure-devops-api.server'
import { credentialUsernameForProvider, mirrorOwnerName, parseCloneUrl } from './parse-clone-url'
import { materializeRepoMirror } from './repo-mirror.server'
import { listRecentCommits, type GitCommitSummary } from './git-local.server'
import { createProject, getProjectById } from '$lib/projects/projects.server'
import type { ProjectRow } from '$lib/projects/projects.schema'
import { logger } from '$lib/observability/logger'

/**
 * Wave 5 #19 phase 1 — server CRUD for source-control records.
 *
 * Schema-only slice — provider sync (poll/webhook against GitHub etc.) is Phase 5 work.
 * For now this module exposes the durable record management so a UI can attach repos +
 * track PRs that are created out-of-band (e.g. manually via gh CLI). Phase 3 adds the
 * agent tool surface; Phase 4 adds provider-side PR creation.
 */

// ─────────── Repositories ───────────

export type AttachRepositoryInput = {
	userId: string
	provider?: SourceControlProvider
	owner: string
	name: string
	cloneUrl: string
	defaultBranch?: string
	projectId?: string | null
	metadata?: Record<string, unknown>
}

export async function attachRepository(input: AttachRepositoryInput): Promise<RepositoryRow> {
	const [row] = await db
		.insert(repositories)
		.values({
			userId: input.userId,
			provider: input.provider ?? 'github',
			owner: input.owner,
			name: input.name,
			cloneUrl: input.cloneUrl,
			defaultBranch: input.defaultBranch ?? 'main',
			projectId: input.projectId ?? null,
			metadata: input.metadata ?? {},
		})
		.returning()
	return row
}

export async function listRepositories(userId: string): Promise<RepositoryRow[]> {
	return db
		.select()
		.from(repositories)
		.where(eq(repositories.userId, userId))
		.orderBy(desc(repositories.updatedAt))
}

/**
 * List only repos that have been imported via the new flow — i.e. rows where
 * `metadata.localPath` is set. Filters out legacy bulk-synced rows that were never
 * downloaded. Used by the `/source-control` page and the agent's `list_my_repos` tool.
 */
export async function listImportedRepositories(userId: string): Promise<RepositoryRow[]> {
	return db
		.select()
		.from(repositories)
		.where(
			and(
				eq(repositories.userId, userId),
				sql`${repositories.metadata}->>'localPath' is not null`,
			),
		)
		.orderBy(desc(repositories.updatedAt))
}

/**
 * Count of legacy bulk-synced rows (no `metadata.localPath`). The page uses this to show
 * a small footer note inviting the user to re-import them via the new flow.
 */
export async function countLegacySyncedRepositories(userId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(repositories)
		.where(
			and(
				eq(repositories.userId, userId),
				sql`${repositories.metadata}->>'localPath' is null`,
			),
		)
	return row?.count ?? 0
}

export async function getRepositoryById(repositoryId: string): Promise<RepositoryRow | null> {
	const [row] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1)
	return row ?? null
}

// ─────────── Connections ───────────

export type UpsertConnectionInput = {
	userId: string
	provider: SourceControlProvider
	providerAccount: string
	encryptedToken: string
	scopes?: string[]
}

export async function upsertConnection(input: UpsertConnectionInput): Promise<RepositoryConnectionRow> {
	const [row] = await db
		.insert(repositoryConnections)
		.values({
			userId: input.userId,
			provider: input.provider,
			providerAccount: input.providerAccount,
			encryptedToken: input.encryptedToken,
			scopes: input.scopes ?? [],
			status: 'active',
			lastSyncedAt: new Date(),
			lastError: null,
		})
		.onConflictDoUpdate({
			target: [
				repositoryConnections.userId,
				repositoryConnections.provider,
				repositoryConnections.providerAccount,
			],
			set: {
				encryptedToken: input.encryptedToken,
				scopes: input.scopes ?? [],
				status: 'active',
				lastSyncedAt: new Date(),
				lastError: null,
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function markConnectionStatus(
	connectionId: string,
	status: 'active' | 'error' | 'revoked' | 'pending',
	lastError?: string | null,
): Promise<RepositoryConnectionRow | null> {
	const [row] = await db
		.update(repositoryConnections)
		.set({ status, lastError: lastError ?? null, updatedAt: new Date() })
		.where(eq(repositoryConnections.id, connectionId))
		.returning()
	return row ?? null
}

export async function listConnections(userId: string): Promise<RepositoryConnectionRow[]> {
	return db
		.select()
		.from(repositoryConnections)
		.where(eq(repositoryConnections.userId, userId))
		.orderBy(desc(repositoryConnections.updatedAt))
}

// ─────────── Pull requests ───────────

export type RecordPullRequestInput = {
	repositoryId: string
	providerPrNumber: number
	title: string
	body?: string | null
	headBranch: string
	baseBranch: string
	status?: PullRequestStatus
	taskId?: string | null
	runId?: string | null
	createdBy?: string | null
	providerUrl?: string | null
	metadata?: Record<string, unknown>
}

/**
 * Record a pull request known to the system. Idempotent on (repositoryId, providerPrNumber)
 * — re-recording an existing PR updates the mutable fields (status, body, metadata, etc.)
 * without creating a duplicate row. Use for both agent-created and externally-created PRs.
 */
export async function recordPullRequest(input: RecordPullRequestInput): Promise<PullRequestRow> {
	const [row] = await db
		.insert(pullRequests)
		.values({
			repositoryId: input.repositoryId,
			providerPrNumber: input.providerPrNumber,
			title: input.title,
			body: input.body ?? null,
			headBranch: input.headBranch,
			baseBranch: input.baseBranch,
			status: input.status ?? 'draft',
			taskId: input.taskId ?? null,
			runId: input.runId ?? null,
			createdBy: input.createdBy ?? null,
			providerUrl: input.providerUrl ?? null,
			metadata: input.metadata ?? {},
		})
		.onConflictDoUpdate({
			target: [pullRequests.repositoryId, pullRequests.providerPrNumber],
			set: {
				title: input.title,
				body: input.body ?? null,
				status: input.status ?? 'draft',
				providerUrl: input.providerUrl ?? null,
				metadata: input.metadata ?? {},
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function listPullRequestsForRepository(repositoryId: string): Promise<PullRequestRow[]> {
	return db
		.select()
		.from(pullRequests)
		.where(eq(pullRequests.repositoryId, repositoryId))
		.orderBy(desc(pullRequests.updatedAt))
}

export async function getPullRequestById(prId: string): Promise<PullRequestRow | null> {
	const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, prId)).limit(1)
	return row ?? null
}

// ─────────── PR checks ───────────

export async function recordPullRequestCheck(input: {
	pullRequestId: string
	checkName: string
	status: 'pending' | 'running' | 'success' | 'failure' | 'canceled' | 'skipped'
	detailsUrl?: string | null
	metadata?: Record<string, unknown>
	startedAt?: Date | null
	finishedAt?: Date | null
}) {
	const [row] = await db
		.insert(pullRequestChecks)
		.values({
			pullRequestId: input.pullRequestId,
			checkName: input.checkName,
			status: input.status,
			detailsUrl: input.detailsUrl ?? null,
			metadata: input.metadata ?? {},
			startedAt: input.startedAt ?? null,
			finishedAt: input.finishedAt ?? null,
		})
		.onConflictDoUpdate({
			target: [pullRequestChecks.pullRequestId, pullRequestChecks.checkName],
			set: {
				status: input.status,
				detailsUrl: input.detailsUrl ?? null,
				metadata: input.metadata ?? {},
				startedAt: input.startedAt ?? null,
				finishedAt: input.finishedAt ?? null,
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function listChecksForPullRequest(prId: string) {
	return db
		.select()
		.from(pullRequestChecks)
		.where(eq(pullRequestChecks.pullRequestId, prId))
		.orderBy(pullRequestChecks.checkName)
}

// ─────────── Branch tracking ───────────

export async function recordBranch(input: {
	repositoryId: string
	name: string
	taskId?: string | null
	createdByRunId?: string | null
	headSha?: string | null
	isDefault?: boolean
	state?: string | null
}) {
	const [row] = await db
		.insert(repositoryBranches)
		.values({
			repositoryId: input.repositoryId,
			name: input.name,
			taskId: input.taskId ?? null,
			createdByRunId: input.createdByRunId ?? null,
			headSha: input.headSha ?? null,
			isDefault: input.isDefault ?? false,
			state: input.state ?? null,
		})
		.onConflictDoUpdate({
			target: [repositoryBranches.repositoryId, repositoryBranches.name],
			set: {
				headSha: input.headSha ?? null,
				state: input.state ?? null,
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function listBranchesForRepository(repositoryId: string) {
	return db
		.select()
		.from(repositoryBranches)
		.where(eq(repositoryBranches.repositoryId, repositoryId))
		.orderBy(desc(repositoryBranches.updatedAt))
}

void and // tree-shake guard

// ─────────── GitHub OAuth integration ───────────

/**
 * Wave 5 #19 phase 2 — fetch the active GitHub connection for a user. Returns the
 * decrypted token alongside the row metadata so callers can hit the GitHub API. Returns
 * null when there is no active connection (caller should prompt the user to connect).
 *
 * Decryption failures (token-rotation gone wrong, key changed) flip the connection to
 * `status='error'` and return null — the user re-runs the OAuth flow to recover.
 */
export async function getActiveGithubConnection(
	userId: string,
): Promise<{ connection: RepositoryConnectionRow; accessToken: string } | null> {
	const [row] = await db
		.select()
		.from(repositoryConnections)
		.where(
			and(
				eq(repositoryConnections.userId, userId),
				eq(repositoryConnections.provider, 'github'),
				eq(repositoryConnections.status, 'active'),
			),
		)
		.orderBy(desc(repositoryConnections.updatedAt))
		.limit(1)
	if (!row) return null
	try {
		const accessToken = decryptSecret(row.encryptedToken)
		return { connection: row, accessToken }
	} catch (err) {
		logger.warn('[source-control] decrypt failed; marking connection as error', { err })
		await markConnectionStatus(row.id, 'error', 'Token decrypt failed')
		return null
	}
}

/**
 * Wave 5 #19 phase 2 — sync the authenticated user's GitHub repos into our `repositories`
 * table. Idempotent: rows are upserted on (userId, owner, name). Returns a summary so the
 * UI can show "Synced N repos (M new, K updated)".
 *
 * Skips fork + archived repos by default — they're rarely the active work surface and
 * inflate the list. Flag both off if the user wants the firehose.
 */
export async function syncGithubReposForUser(
	userId: string,
	options?: { includeForks?: boolean; includeArchived?: boolean; maxPages?: number },
): Promise<{ total: number; inserted: number; updated: number; skipped: number; errorMessage?: string }> {
	const conn = await getActiveGithubConnection(userId)
	if (!conn) {
		return { total: 0, inserted: 0, updated: 0, skipped: 0, errorMessage: 'No active GitHub connection' }
	}

	let remoteRepos: GithubRepoSummary[]
	try {
		remoteRepos = await listAuthenticatedUserRepos(conn.accessToken, { maxPages: options?.maxPages })
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		await markConnectionStatus(conn.connection.id, 'error', message)
		if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
			return { total: 0, inserted: 0, updated: 0, skipped: 0, errorMessage: message }
		}
		return { total: 0, inserted: 0, updated: 0, skipped: 0, errorMessage: message }
	}

	let inserted = 0
	let updated = 0
	let skipped = 0
	for (const repo of remoteRepos) {
		if (!options?.includeForks && repo.fork) {
			skipped++
			continue
		}
		if (!options?.includeArchived && repo.archived) {
			skipped++
			continue
		}
		const result = await db
			.insert(repositories)
			.values({
				userId,
				provider: 'github',
				owner: repo.owner.login,
				name: repo.name,
				cloneUrl: repo.cloneUrl,
				defaultBranch: repo.defaultBranch,
				metadata: {
					htmlUrl: repo.htmlUrl,
					sshUrl: repo.sshUrl,
					private: repo.private,
					description: repo.description,
					archived: repo.archived,
					fork: repo.fork,
					providerRepoId: repo.id,
					ownerType: repo.owner.type,
					stargazersCount: repo.stargazersCount,
					pushedAt: repo.pushedAt,
				},
			})
			.onConflictDoUpdate({
				target: [repositories.userId, repositories.owner, repositories.name],
				set: {
					cloneUrl: repo.cloneUrl,
					defaultBranch: repo.defaultBranch,
					metadata: {
						htmlUrl: repo.htmlUrl,
						sshUrl: repo.sshUrl,
						private: repo.private,
						description: repo.description,
						archived: repo.archived,
						fork: repo.fork,
						providerRepoId: repo.id,
						ownerType: repo.owner.type,
						stargazersCount: repo.stargazersCount,
						pushedAt: repo.pushedAt,
					},
					updatedAt: new Date(),
				},
			})
			.returning({ id: repositories.id, createdAt: repositories.createdAt, updatedAt: repositories.updatedAt })
		const row = result[0]
		if (row && row.createdAt.getTime() === row.updatedAt.getTime()) {
			inserted++
		} else {
			updated++
		}
	}

	// Touch lastSyncedAt on the connection regardless of insert/update split.
	await db
		.update(repositoryConnections)
		.set({ lastSyncedAt: new Date(), status: 'active', lastError: null, updatedAt: new Date() })
		.where(eq(repositoryConnections.id, conn.connection.id))

	return { total: remoteRepos.length, inserted, updated, skipped }
}

/**
 * Disconnect a GitHub OAuth connection. Idempotent: re-disconnecting an already-revoked
 * connection is a no-op. The row is preserved for the audit trail; it just flips to
 * `status='revoked'` and the encrypted token is overwritten with the empty string so a
 * decrypt attempt fails fast.
 */
export async function disconnectGithubForUser(userId: string): Promise<{ ok: boolean }> {
	await db
		.update(repositoryConnections)
		.set({ status: 'revoked', encryptedToken: '', lastSyncedAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(repositoryConnections.userId, userId),
				eq(repositoryConnections.provider, 'github'),
			),
		)
	return { ok: true }
}

// ─────────── Azure DevOps OAuth integration ───────────

/**
 * Source control redesign — fetch the active Azure DevOps connection for a user + org. The
 * `repositoryConnections` table is keyed on (userId, provider, providerAccount), and for
 * Azure DevOps we use `providerAccount = org name` so each org gets its own row (the
 * OAuth callback writes one row per account returned by `/_apis/accounts`).
 *
 * Returns null when no active connection exists (caller prompts the user to connect).
 * Decryption failures flip the row to `status='error'` like the GitHub equivalent.
 */
export async function getActiveAzureConnection(
	userId: string,
	org: string,
): Promise<{ connection: RepositoryConnectionRow; accessToken: string } | null> {
	const [row] = await db
		.select()
		.from(repositoryConnections)
		.where(
			and(
				eq(repositoryConnections.userId, userId),
				eq(repositoryConnections.provider, 'azure_devops'),
				eq(repositoryConnections.providerAccount, org),
				eq(repositoryConnections.status, 'active'),
			),
		)
		.orderBy(desc(repositoryConnections.updatedAt))
		.limit(1)
	if (!row) return null
	try {
		const accessToken = decryptSecret(row.encryptedToken)
		return { connection: row, accessToken }
	} catch (err) {
		logger.warn('[source-control] azure decrypt failed; marking connection as error', { err })
		await markConnectionStatus(row.id, 'error', 'Token decrypt failed')
		return null
	}
}

export async function listActiveAzureConnections(
	userId: string,
): Promise<RepositoryConnectionRow[]> {
	return db
		.select()
		.from(repositoryConnections)
		.where(
			and(
				eq(repositoryConnections.userId, userId),
				eq(repositoryConnections.provider, 'azure_devops'),
				eq(repositoryConnections.status, 'active'),
			),
		)
		.orderBy(desc(repositoryConnections.updatedAt))
}

export async function disconnectAzureForUser(userId: string): Promise<{ ok: boolean }> {
	await db
		.update(repositoryConnections)
		.set({ status: 'revoked', encryptedToken: '', lastSyncedAt: new Date(), updatedAt: new Date() })
		.where(
			and(
				eq(repositoryConnections.userId, userId),
				eq(repositoryConnections.provider, 'azure_devops'),
			),
		)
	return { ok: true }
}

// ─────────── Import flow ───────────

function getMirrorRoot(userId: string): string {
	const sandboxRoot = process.env.SANDBOX_WORKSPACE || '/workspace/users'
	return `${sandboxRoot}/${userId}/repos`
}

export type ImportRepositoryInput = {
	userId: string
	cloneUrl: string
	projectId?: string | null
	projectName?: string | null
}

export type ImportRepositoryResult = {
	repository: RepositoryRow
	project: ProjectRow | null
}

/**
 * Source control redesign — orchestrator for the new "Import repository" flow.
 *
 *   1. Parse the URL to figure out provider + identity segments.
 *   2. Resolve auth: GitHub uses the active OAuth token; Azure DevOps looks up a per-org
 *      OAuth connection; local URLs use no auth.
 *   3. Materialize the repo's local mirror (clone or fetch).
 *   4. Auto-create a `code` Project unless the caller passed an existing `projectId`.
 *   5. Insert the repository row with `metadata.localPath` (the import marker the page
 *      filters on) + `lastImportedAt` + provider-specific extras.
 *   6. Record the default branch as a `repositoryBranches` row.
 *
 * Throws on any failure — the caller surfaces the message in the import modal.
 */
export async function importRepository(input: ImportRepositoryInput): Promise<ImportRepositoryResult> {
	const parsed = parseCloneUrl(input.cloneUrl)
	const { owner, name } = mirrorOwnerName(parsed)

	let token = ''
	let credentialUsername = credentialUsernameForProvider(parsed.provider)

	if (parsed.provider === 'github') {
		const conn = await getActiveGithubConnection(input.userId)
		if (!conn) {
			throw new Error(
				'No active GitHub connection. Connect GitHub at /source-control before importing private repos.',
			)
		}
		token = conn.accessToken
	} else if (parsed.provider === 'azure_devops') {
		const conn = await getActiveAzureConnection(input.userId, parsed.org)
		if (conn) {
			token = conn.accessToken
		} else {
			// Fall back to anonymous; public Azure repos work that way and the operator
			// can connect later if a private clone fails.
			token = ''
			credentialUsername = ''
		}
	} else {
		token = ''
		credentialUsername = ''
	}

	const mirror = await materializeRepoMirror({
		mirrorRoot: getMirrorRoot(input.userId),
		owner,
		repo: name,
		token,
		cloneUrl: parsed.cloneUrl,
		credentialUsername,
	})

	let projectRow: ProjectRow | null = null
	if (input.projectId) {
		const existing = await getProjectById(input.projectId)
		if (!existing || existing.userId !== input.userId) {
			throw new Error('Selected project not found or not owned by this user.')
		}
		projectRow = existing
	} else {
		projectRow = await createProject({
			userId: input.userId,
			name: input.projectName?.trim() || `${owner}/${name}`,
			description: `Source-controlled project for ${parsed.cloneUrl}`,
			kind: 'code',
		})
	}

	const baseMetadata: Record<string, unknown> = {
		localPath: mirror.path,
		lastImportedAt: new Date().toISOString(),
		htmlUrl: parsed.htmlUrl,
		cloneUrl: parsed.cloneUrl,
	}
	if (parsed.provider === 'azure_devops') {
		baseMetadata.azure = { org: parsed.org, project: parsed.project, repo: parsed.repo }
	}
	if (parsed.provider === 'local') {
		baseMetadata.host = parsed.host
	}

	const defaultBranch = mirror.branch ?? 'main'

	// Use upsert semantics so re-importing an existing repo refreshes its metadata
	// (e.g. the user changed the linked project) without duplicating rows.
	const [row] = await db
		.insert(repositories)
		.values({
			userId: input.userId,
			provider: parsed.provider,
			owner,
			name,
			cloneUrl: parsed.cloneUrl,
			defaultBranch,
			projectId: projectRow?.id ?? null,
			metadata: baseMetadata,
		})
		.onConflictDoUpdate({
			target: [repositories.userId, repositories.owner, repositories.name],
			set: {
				cloneUrl: parsed.cloneUrl,
				defaultBranch,
				projectId: projectRow?.id ?? null,
				metadata: baseMetadata,
				updatedAt: new Date(),
			},
		})
		.returning()

	await db
		.insert(repositoryBranches)
		.values({
			repositoryId: row.id,
			name: defaultBranch,
			isDefault: true,
		})
		.onConflictDoUpdate({
			target: [repositoryBranches.repositoryId, repositoryBranches.name],
			set: {
				isDefault: true,
				updatedAt: new Date(),
			},
		})

	return { repository: row, project: projectRow }
}

/**
 * Re-run the mirror materialization for an already-imported repo. Updates `lastPulledAt`
 * on the row's metadata so the UI can show "Last pulled 5m ago".
 */
export async function pullRepositoryLatest(
	userId: string,
	repositoryId: string,
): Promise<{ repository: RepositoryRow; fresh: boolean; branch: string | null }> {
	const repo = await getRepositoryById(repositoryId)
	if (!repo) throw new Error('Repository not found.')
	if (repo.userId !== userId) throw new Error('Not authorized for this repository.')

	let token = ''
	let credentialUsername = credentialUsernameForProvider(repo.provider)
	if (repo.provider === 'github') {
		const conn = await getActiveGithubConnection(userId)
		if (!conn) throw new Error('GitHub connection unavailable. Reconnect at /source-control.')
		token = conn.accessToken
	} else if (repo.provider === 'azure_devops') {
		const azure = (repo.metadata as { azure?: { org?: string } }).azure
		if (azure?.org) {
			const conn = await getActiveAzureConnection(userId, azure.org)
			if (conn) {
				token = conn.accessToken
			} else {
				token = ''
				credentialUsername = ''
			}
		}
	}

	const mirror = await materializeRepoMirror({
		mirrorRoot: getMirrorRoot(userId),
		owner: repo.owner,
		repo: repo.name,
		token,
		cloneUrl: repo.cloneUrl,
		credentialUsername,
	})

	const nextMetadata = {
		...((repo.metadata as Record<string, unknown>) ?? {}),
		localPath: mirror.path,
		lastPulledAt: new Date().toISOString(),
	}
	const [updated] = await db
		.update(repositories)
		.set({ metadata: nextMetadata, defaultBranch: mirror.branch ?? repo.defaultBranch, updatedAt: new Date() })
		.where(eq(repositories.id, repo.id))
		.returning()

	return { repository: updated, fresh: mirror.fresh, branch: mirror.branch }
}

export type RepositoryDetail = {
	repository: RepositoryRow
	project: ProjectRow | null
	commits: GitCommitSummary[]
	chats: Array<{
		id: string
		title: string
		agentName: string | null
		updatedAt: Date
	}>
	pullRequestList: PullRequestRow[]
	branches: Array<{
		id: string
		name: string
		isDefault: boolean
		headSha: string | null
		updatedAt: Date
	}>
}

export async function getRepositoryDetail(
	userId: string,
	repositoryId: string,
): Promise<RepositoryDetail> {
	const repo = await getRepositoryById(repositoryId)
	if (!repo) throw new Error('Repository not found.')
	if (repo.userId !== userId) throw new Error('Not authorized for this repository.')

	const project = repo.projectId ? await getProjectById(repo.projectId) : null
	const localPath = (repo.metadata as { localPath?: string }).localPath ?? null

	const [commits, chats, pullRequestList, branches] = await Promise.all([
		localPath ? listRecentCommits(localPath, { limit: 10 }) : Promise.resolve([]),
		project
			? db
					.select({
						id: conversations.id,
						title: conversations.title,
						agentName: agents.name,
						updatedAt: conversations.updatedAt,
					})
					.from(conversations)
					.leftJoin(agents, eq(agents.id, conversations.agentId))
					.where(
						and(
							eq(conversations.userId, userId),
							eq(conversations.projectId, project.id),
						),
					)
					.orderBy(desc(conversations.updatedAt))
					.limit(10)
			: Promise.resolve([] as Array<{ id: string; title: string; agentName: string | null; updatedAt: Date }>),
		listPullRequestsForRepository(repo.id),
		db
			.select({
				id: repositoryBranches.id,
				name: repositoryBranches.name,
				isDefault: repositoryBranches.isDefault,
				headSha: repositoryBranches.headSha,
				updatedAt: repositoryBranches.updatedAt,
			})
			.from(repositoryBranches)
			.where(eq(repositoryBranches.repositoryId, repo.id))
			.orderBy(desc(repositoryBranches.updatedAt))
			.limit(20),
	])

	return { repository: repo, project, commits, chats, pullRequestList, branches }
}

export type GithubImportCandidate = {
	owner: string
	name: string
	defaultBranch: string
	htmlUrl: string
	cloneUrl: string
	private: boolean
	description: string | null
	alreadyImported: boolean
}

export async function listGithubImportCandidates(userId: string): Promise<{
	candidates: GithubImportCandidate[]
	errorMessage?: string
}> {
	const conn = await getActiveGithubConnection(userId)
	if (!conn) return { candidates: [], errorMessage: 'No active GitHub connection.' }

	let remoteRepos: GithubRepoSummary[]
	try {
		remoteRepos = await listAuthenticatedUserRepos(conn.accessToken, { maxPages: 4 })
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
			await markConnectionStatus(conn.connection.id, 'error', message)
		}
		return { candidates: [], errorMessage: message }
	}

	const ownedRows = await db
		.select({ owner: repositories.owner, name: repositories.name, metadata: repositories.metadata })
		.from(repositories)
		.where(and(eq(repositories.userId, userId), eq(repositories.provider, 'github')))
	const importedKeys = new Set(
		ownedRows
			.filter((r) => (r.metadata as { localPath?: string }).localPath)
			.map((r) => `${r.owner}/${r.name}`),
	)

	return {
		candidates: remoteRepos.map((r) => ({
			owner: r.owner.login,
			name: r.name,
			defaultBranch: r.defaultBranch,
			htmlUrl: r.htmlUrl,
			cloneUrl: r.cloneUrl,
			private: r.private,
			description: r.description,
			alreadyImported: importedKeys.has(`${r.owner.login}/${r.name}`),
		})),
	}
}

export type AzureImportCandidate = {
	org: string
	project: string
	name: string
	defaultBranch: string
	cloneUrl: string
	htmlUrl: string
	alreadyImported: boolean
}

export async function listAzureImportCandidates(userId: string): Promise<{
	candidates: AzureImportCandidate[]
	errorMessage?: string
}> {
	const connections = await listActiveAzureConnections(userId)
	if (connections.length === 0) {
		return { candidates: [], errorMessage: 'No active Azure DevOps connection.' }
	}

	const ownedRows = await db
		.select({ owner: repositories.owner, name: repositories.name, metadata: repositories.metadata })
		.from(repositories)
		.where(and(eq(repositories.userId, userId), eq(repositories.provider, 'azure_devops')))
	const importedKeys = new Set(
		ownedRows
			.filter((r) => (r.metadata as { localPath?: string }).localPath)
			.map((r) => `${r.owner}/${r.name}`),
	)

	const all: AzureImportCandidate[] = []
	const errors: string[] = []
	for (const conn of connections) {
		const azureConn = await getActiveAzureConnection(userId, conn.providerAccount)
		if (!azureConn) continue
		try {
			const repos: AzureRepoSummary[] = await listAzureRepositoriesForOrg(
				azureConn.accessToken,
				conn.providerAccount,
			)
			for (const r of repos) {
				all.push({
					org: conn.providerAccount,
					project: r.project,
					name: r.name,
					defaultBranch: r.defaultBranch,
					cloneUrl: r.cloneUrl,
					htmlUrl: r.htmlUrl,
					alreadyImported: importedKeys.has(`${conn.providerAccount}/${r.name}`),
				})
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			if (err instanceof AzureDevOpsApiError && (err.status === 401 || err.status === 403)) {
				await markConnectionStatus(conn.id, 'error', message)
			}
			errors.push(`${conn.providerAccount}: ${message}`)
		}
	}

	return {
		candidates: all,
		errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
	}
}

/**
 * Detach a repo: delete the row (existing FK cascades remove branches + PRs + checks).
 * The on-disk clone is intentionally preserved — re-importing recovers the same path
 * without re-cloning. The user can `rm -rf` the mirror manually if they want a fresh state.
 */
export async function detachRepository(userId: string, repositoryId: string): Promise<{ ok: boolean }> {
	const [row] = await db
		.select({ id: repositories.id, userId: repositories.userId })
		.from(repositories)
		.where(eq(repositories.id, repositoryId))
		.limit(1)
	if (!row) return { ok: false }
	if (row.userId !== userId) throw new Error('Not authorized for this repository.')
	await db.delete(repositories).where(eq(repositories.id, repositoryId))
	return { ok: true }
}

void inArray // tree-shake guard (referenced for type safety in future joins)
