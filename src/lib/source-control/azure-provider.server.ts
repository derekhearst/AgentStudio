/**
 * Azure DevOps OAuth integration: connection lookup, list active orgs, disconnect, import candidates.
 *
 * Mirrors github-provider.server.ts but uses `providerAccount = org name` so each org gets
 * its own connection row. The OAuth callback writes one row per org returned by
 * `/_apis/accounts`. Shared helpers (`markConnectionStatus`) still live in source-control.server.ts.
 */

import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { logger } from '$lib/observability/logger'
import { decryptSecret } from './encryption.server'
import {
	AzureDevOpsApiError,
	listAzureRepositoriesForOrg,
	type AzureRepoSummary,
} from './azure-devops-api.server'
import {
	repositories,
	repositoryConnections,
	type RepositoryConnectionRow,
} from './source-control.schema'
import { markConnectionStatus } from './source-control.server'

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
