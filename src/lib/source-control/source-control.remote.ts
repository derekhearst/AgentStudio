import { command, query } from '$app/server'
import { z } from 'zod'
import {
	countLegacySyncedRepositories,
	detachRepository,
	disconnectAzureForUser,
	disconnectGithubForUser,
	getRepositoryDetail,
	importRepository,
	listActiveAzureConnections,
	listAzureImportCandidates,
	listConnections,
	listGithubImportCandidates,
	listImportedRepositories,
	pullRepositoryLatest,
} from './source-control.server'
import { isGithubOAuthConfigured } from './github-oauth.server'
import { isAzureDevOpsOAuthConfigured } from './azure-devops-oauth.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Source control redesign — UI surface for /source-control admin page.
 *
 * The page lists only IMPORTED repos (rows where `metadata.localPath` is set). Bulk-sync
 * is no longer triggered from the UI; the agent's `sync_my_repos` tool keeps that surface.
 *
 * OAuth connect/callback handlers live in /source-control/{github,azure-devops}/* SvelteKit
 * endpoints (server-side redirects).
 */

export const getSourceControlOverviewQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [connections, repos, legacyCount] = await Promise.all([
		listConnections(user.id),
		listImportedRepositories(user.id),
		countLegacySyncedRepositories(user.id),
	])
	return {
		githubConfigured: isGithubOAuthConfigured(),
		azureConfigured: isAzureDevOpsOAuthConfigured(),
		legacySyncedCount: legacyCount,
		connections: connections.map((c) => ({
			id: c.id,
			provider: c.provider,
			providerAccount: c.providerAccount,
			scopes: c.scopes,
			status: c.status,
			lastSyncedAt: c.lastSyncedAt,
			lastError: c.lastError,
			updatedAt: c.updatedAt,
		})),
		repositories: repos.map((r) => ({
			id: r.id,
			provider: r.provider,
			owner: r.owner,
			name: r.name,
			defaultBranch: r.defaultBranch,
			cloneUrl: r.cloneUrl,
			projectId: r.projectId,
			metadata: r.metadata,
			updatedAt: r.updatedAt,
		})),
	}
})

export const disconnectGithubCommand = command(async () => {
	const user = requireAuthenticatedRequestUser()
	return disconnectGithubForUser(user.id)
})

export const disconnectAzureCommand = command(async () => {
	const user = requireAuthenticatedRequestUser()
	return disconnectAzureForUser(user.id)
})

const importSchema = z.object({
	cloneUrl: z.string().trim().min(1).max(2000),
	projectId: z.string().uuid().nullable().optional(),
	projectName: z.string().trim().max(120).nullable().optional(),
})

export const importRepositoryCommand = command(importSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const result = await importRepository({
		userId: user.id,
		cloneUrl: input.cloneUrl,
		projectId: input.projectId ?? null,
		projectName: input.projectName ?? null,
	})
	return {
		repository: {
			id: result.repository.id,
			provider: result.repository.provider,
			owner: result.repository.owner,
			name: result.repository.name,
			defaultBranch: result.repository.defaultBranch,
			cloneUrl: result.repository.cloneUrl,
			projectId: result.repository.projectId,
			metadata: result.repository.metadata,
		},
		project: result.project
			? {
					id: result.project.id,
					name: result.project.name,
					slug: result.project.slug,
					kind: result.project.kind,
				}
			: null,
	}
})

const repoIdSchema = z.object({ repositoryId: z.string().uuid() })

export const pullRepositoryCommand = command(repoIdSchema, async ({ repositoryId }) => {
	const user = requireAuthenticatedRequestUser()
	const result = await pullRepositoryLatest(user.id, repositoryId)
	return {
		repositoryId: result.repository.id,
		fresh: result.fresh,
		branch: result.branch,
		metadata: result.repository.metadata,
		updatedAt: result.repository.updatedAt,
	}
})

export const detachRepositoryCommand = command(repoIdSchema, async ({ repositoryId }) => {
	const user = requireAuthenticatedRequestUser()
	return detachRepository(user.id, repositoryId)
})

export const getRepositoryDetailQuery = query(repoIdSchema, async ({ repositoryId }) => {
	const user = requireAuthenticatedRequestUser()
	const detail = await getRepositoryDetail(user.id, repositoryId)
	return {
		repository: {
			id: detail.repository.id,
			provider: detail.repository.provider,
			owner: detail.repository.owner,
			name: detail.repository.name,
			defaultBranch: detail.repository.defaultBranch,
			cloneUrl: detail.repository.cloneUrl,
			projectId: detail.repository.projectId,
			metadata: detail.repository.metadata,
			updatedAt: detail.repository.updatedAt,
		},
		project: detail.project
			? {
					id: detail.project.id,
					name: detail.project.name,
					slug: detail.project.slug,
					kind: detail.project.kind,
				}
			: null,
		commits: detail.commits,
		chats: detail.chats,
		pullRequests: detail.pullRequestList.map((pr) => ({
			id: pr.id,
			providerPrNumber: pr.providerPrNumber,
			title: pr.title,
			status: pr.status,
			headBranch: pr.headBranch,
			baseBranch: pr.baseBranch,
			providerUrl: pr.providerUrl,
			updatedAt: pr.updatedAt,
		})),
		branches: detail.branches,
	}
})

export const listGithubImportCandidatesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listGithubImportCandidates(user.id)
})

export const listAzureImportCandidatesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [{ candidates, errorMessage }, connections] = await Promise.all([
		listAzureImportCandidates(user.id),
		listActiveAzureConnections(user.id),
	])
	return {
		candidates,
		errorMessage,
		orgs: connections.map((c) => c.providerAccount),
	}
})
