/**
 * Repository import + lifecycle: clone-and-mirror, refresh-pull, repo detail
 * aggregator, detach.
 *
 * Extracted from source-control.server.ts so the durable repository CRUD
 * (rows, connections, PRs, branches) is editable in isolation from the
 * filesystem-touching mirror flow.
 */

import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { getSandboxRoot } from '$lib/server/config'
import { createProject, getProjectById } from '$lib/projects/projects.server'
import type { ProjectRow } from '$lib/projects/projects.schema'
import { credentialUsernameForProvider, mirrorOwnerName, parseCloneUrl } from './parse-clone-url'
import { materializeRepoMirror } from './repo-mirror.server'
import { listRecentCommits, type GitCommitSummary } from './git-local.server'
import { getActiveAzureConnection } from './azure-provider.server'
import { getActiveGithubConnection } from './github-provider.server'
import {
	repositories,
	repositoryBranches,
	type PullRequestRow,
	type RepositoryRow,
} from './source-control.schema'
import { getRepositoryById, listPullRequestsForRepository } from './source-control.server'

/** Each user's repos live under `<SANDBOX_WORKSPACE>/<userId>/repos/`. */
function getMirrorRoot(userId: string): string {
	return `${getSandboxRoot()}/${userId}/repos`
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
		const created = await createProject({
			userId: input.userId,
			name: input.projectName?.trim() || `${owner}/${name}`,
			description: `Source-controlled project for ${parsed.cloneUrl}`,
			kind: 'code',
			repoMode: 'none',
		})
		projectRow = created.project
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

/**
 * Detach a repo: delete the row (existing FK cascades remove branches + PRs + checks).
 * The on-disk clone is intentionally preserved — re-importing recovers the same path
 * without re-cloning. The user can `rm -rf` the mirror manually if they want a fresh state.
 */
export async function detachRepository(
	userId: string,
	repositoryId: string,
): Promise<{ ok: boolean }> {
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
