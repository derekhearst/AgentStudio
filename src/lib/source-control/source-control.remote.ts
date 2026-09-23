import { error } from '@sveltejs/kit'
import { command, query } from '$app/server'
import { z } from 'zod'
import {
	countLegacySyncedRepositories,
	detachRepository,
	disconnectGithubForUser,
	getRepositoryDetail,
	importRepository,
	listConnections,
	listGithubImportCandidates,
	listImportedRepositories,
	pullRepositoryLatest,
} from './source-control.server'
import { isGithubOAuthConfigured } from './github-oauth.server'
import { findPullRequestForFix } from './pr-fix.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Source control redesign — UI surface for /source-control admin page.
 *
 * The page lists only IMPORTED repos (rows where `metadata.localPath` is set). Bulk-sync
 * is no longer triggered from the UI; the agent's `sync_my_repos` tool keeps that surface.
 *
 * OAuth connect/callback handlers live in /source-control/github/* SvelteKit
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
		summary: result.summary,
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

/**
 * #20 — the "Fix it" button on a `pull_request_checks_failed` review item.
 *
 * Enqueues rather than running inline: a fix run is an agent loop that can take minutes,
 * and it must survive the request that started it. The operator gets a job id back
 * immediately and the run appears in the originating conversation when it finishes.
 *
 * Ownership is checked here, before anything is queued, and again inside
 * `startPullRequestFixRun`. The first check is the one that matters for the button: the
 * dedupe key below gives each review item exactly one job, forever, so a press that was
 * going to be refused must not be the one that takes it. The returned `status` says whether
 * that job is new or an earlier one — `describeFixRunJob` turns it into the message.
 */
const startFixSchema = z.object({
	pullRequestId: z.string().uuid(),
	checkName: z.string().trim().max(400).nullable().optional(),
	reviewItemId: z.string().uuid().nullable().optional(),
})

export const startPullRequestFixCommand = command(startFixSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	if (!(await findPullRequestForFix(user.id, input.pullRequestId))) {
		error(404, 'Pull request not found')
	}
	const { enqueueJob } = await import('$lib/jobs/jobs.server')
	const job = await enqueueJob({
		type: 'pr_fix',
		queue: 'default',
		// Operator pressed a button; this outranks background polling.
		priority: 90,
		// Keyed on the review item, not on (PR, check). `(type, dedupeKey)` is unique
		// FOREVER — a key that does not move would make the second press of "Fix it" hand
		// back the first, long-completed job instead of running anything. One review item
		// is one failure on one commit, so one fix run per item is the right grain, and a
		// later failure opens a new item and is therefore fixable again. Without an item
		// id we fall back to a minute bucket: a double-click collapses, a deliberate retry
		// a minute later does not.
		dedupeKey: input.reviewItemId
			? `pr_fix:item:${input.reviewItemId}`
			: `pr_fix:${input.pullRequestId}:${input.checkName ?? 'latest'}:${new Date(
					Math.floor(Date.now() / 60_000) * 60_000,
				).toISOString()}`,
		payload: {
			pullRequestId: input.pullRequestId,
			userId: user.id,
			checkName: input.checkName ?? null,
			reviewItemId: input.reviewItemId ?? null,
		},
		userId: user.id,
	})
	return { jobId: job.id, status: job.status }
})
