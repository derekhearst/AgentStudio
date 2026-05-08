/**
 * GitHub OAuth integration: connection lookup, repo sync, disconnect, import candidates.
 *
 * Extracted from source-control.server.ts so the GitHub-specific surface (token decrypt,
 * remote fetch, sync upsert) is editable in isolation from Azure DevOps + the generic
 * repository CRUD. The shared helpers (`markConnectionStatus`, repository row plumbing)
 * still live in source-control.server.ts.
 */

import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { logger } from '$lib/observability/logger'
import { decryptSecret } from './encryption.server'
import {
	GithubApiError,
	listAuthenticatedUserRepos,
	type GithubRepoSummary,
} from './github-api.server'
import {
	repositories,
	repositoryConnections,
	type RepositoryConnectionRow,
} from './source-control.schema'
import { markConnectionStatus } from './source-control.server'

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
