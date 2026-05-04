import { and, desc, eq } from 'drizzle-orm'
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
import { decryptSecret } from './encryption.server'
import {
	GithubApiError,
	listAuthenticatedUserRepos,
	type GithubRepoSummary,
} from './github-api.server'

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
		console.warn('[source-control] decrypt failed; marking connection as error', err)
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
