import { command, query } from '$app/server'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { repositories } from '$lib/source-control/source-control.schema'
import { listPullRequestsForRepository } from '$lib/source-control/source-control.server'
import {
	createProject,
	deleteProject,
	editArtifact,
	getArtifactById,
	getProjectById,
	getVersion,
	getVersionHistory,
	listArtifactsForProject,
	listProjects,
	rollbackArtifact,
	softDeleteArtifact,
	updateProject,
	createArtifact,
} from './projects.server'
import {
	commitProject,
	createProjectBranch,
	getProjectDiff,
	getProjectStatus,
	listProjectBranches,
	listProjectCommits,
	pullProject,
	pushProjectBranch,
	switchProjectBranch,
} from './project-git.server'
import {
	disconnectAzureForUser,
	disconnectGithubForUser,
	isAzureDevOpsOAuthConfigured,
	isGithubOAuthConfigured,
	listActiveAzureConnections,
	listAzureImportCandidates,
	listConnections,
	listGithubImportCandidates,
} from './connections.server'

/**
 * Projects + Artifacts SvelteKit remote surface, expanded with repo controls.
 *
 * The /projects pages call into this module for everything: the connection cards, the
 * 4-mode creation flow (none/local/github/azure/url), and all repo-level git operations
 * (status, branches, commits, pull, push, commit, diff). The legacy /source-control page
 * is going away — nothing else should still import from $lib/source-control/source-control.remote.
 */

const PROJECT_KIND_VALUES = ['efoil', 'research', 'code', 'documentation', 'other'] as const
const REPO_MODE_VALUES = ['none', 'local', 'imported'] as const
const CONTENT_TYPE_VALUES = ['markdown', 'code', 'json', 'yaml', 'plaintext'] as const

async function ensureProjectOwned(projectId: string, userId: string) {
	const project = await getProjectById(projectId)
	if (!project) throw new Error(`Project ${projectId} not found`)
	if (project.userId !== userId) throw new Error('Not authorized')
	return project
}

async function ensureArtifactOwned(artifactId: string, userId: string) {
	const artifact = await getArtifactById(artifactId)
	if (!artifact) throw new Error(`Artifact ${artifactId} not found`)
	if (artifact.projectId) {
		await ensureProjectOwned(artifact.projectId, userId)
	} else if (artifact.conversationId) {
		const [conv] = await db
			.select({ userId: conversations.userId })
			.from(conversations)
			.where(eq(conversations.id, artifact.conversationId))
			.limit(1)
		if (!conv || conv.userId !== userId) throw new Error('Not authorized')
	} else {
		throw new Error(`Artifact ${artifactId} has no scope`)
	}
	return artifact
}

// ─────────── Project queries + commands ───────────

export const listProjectsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listProjects(user.id)
})

export const getProjectByIdQuery = query(z.string().uuid(), async (projectId) => {
	const user = requireAuthenticatedRequestUser()
	const project = await ensureProjectOwned(projectId, user.id)
	const projectArtifacts = await listArtifactsForProject(project.id)
	return { project, artifacts: projectArtifacts }
})

const githubSourceSchema = z.object({
	type: z.literal('github'),
	owner: z.string().trim().min(1).max(120),
	repo: z.string().trim().min(1).max(120),
	cloneUrl: z.string().trim().min(1).max(2000),
})
const azureSourceSchema = z.object({
	type: z.literal('azure'),
	org: z.string().trim().min(1).max(120),
	project: z.string().trim().min(1).max(120),
	repo: z.string().trim().min(1).max(120),
	cloneUrl: z.string().trim().min(1).max(2000),
})
const urlSourceSchema = z.object({
	type: z.literal('url'),
	cloneUrl: z.string().trim().min(1).max(2000),
})
const importSourceSchema = z.discriminatedUnion('type', [
	githubSourceSchema,
	azureSourceSchema,
	urlSourceSchema,
])

const createProjectSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(1000).optional(),
	kind: z.enum(PROJECT_KIND_VALUES).optional(),
	slug: z.string().trim().min(1).max(64).optional(),
	repoMode: z.enum(REPO_MODE_VALUES).optional(),
	defaultBranch: z.string().trim().min(1).max(120).optional(),
	source: importSourceSchema.optional(),
})

export const createProjectCommand = command(createProjectSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const result = await createProject({
		userId: user.id,
		name: input.name,
		description: input.description ?? null,
		kind: input.kind,
		slug: input.slug,
		repoMode: input.repoMode ?? 'none',
		defaultBranch: input.defaultBranch,
		source: input.source,
	})
	return {
		project: result.project,
		repository: result.repository
			? {
					id: result.repository.id,
					provider: result.repository.provider,
					owner: result.repository.owner,
					name: result.repository.name,
					cloneUrl: result.repository.cloneUrl,
					defaultBranch: result.repository.defaultBranch,
					metadata: result.repository.metadata,
				}
			: null,
		fsPath: result.fsPath,
	}
})

const updateProjectSchema = z.object({
	projectId: z.string().uuid(),
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().max(1000).nullable().optional(),
	kind: z.enum(PROJECT_KIND_VALUES).optional(),
})

export const updateProjectCommand = command(updateProjectSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	return updateProject(input.projectId, {
		name: input.name,
		description: input.description,
		kind: input.kind,
	})
})

export const deleteProjectCommand = command(z.string().uuid(), async (projectId) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(projectId, user.id)
	return deleteProject(projectId)
})

// ─────────── Artifact queries + commands ───────────

export const getArtifactQuery = query(z.string().uuid(), async (artifactId) => {
	const user = requireAuthenticatedRequestUser()
	const artifact = await ensureArtifactOwned(artifactId, user.id)
	const versions = await getVersionHistory(artifactId)
	return { artifact, versions }
})

export const getVersionQuery = query(z.string().uuid(), async (versionId) => {
	const user = requireAuthenticatedRequestUser()
	const version = await getVersion(versionId)
	if (!version) return null
	await ensureArtifactOwned(version.artifactId, user.id)
	return version
})

const createArtifactSchema = z.object({
	projectId: z.string().uuid(),
	name: z.string().trim().min(1).max(160),
	content: z.string(),
	contentType: z.enum(CONTENT_TYPE_VALUES).optional(),
	changeNote: z.string().trim().max(500).optional(),
})

export const createArtifactCommand = command(createArtifactSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	return createArtifact({
		projectId: input.projectId,
		name: input.name,
		content: input.content,
		contentType: input.contentType,
		changeNote: input.changeNote,
		editedBy: user.id,
	})
})

const editArtifactSchema = z.object({
	artifactId: z.string().uuid(),
	content: z.string(),
	changeNote: z.string().trim().max(500).optional(),
})

export const editArtifactCommand = command(editArtifactSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureArtifactOwned(input.artifactId, user.id)
	return editArtifact({
		artifactId: input.artifactId,
		content: input.content,
		changeNote: input.changeNote,
		editedBy: user.id,
	})
})

const rollbackArtifactSchema = z.object({
	artifactId: z.string().uuid(),
	toSeq: z.number().int().min(1),
	changeNote: z.string().trim().max(500).optional(),
})

export const rollbackArtifactCommand = command(rollbackArtifactSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureArtifactOwned(input.artifactId, user.id)
	return rollbackArtifact({
		artifactId: input.artifactId,
		toSeq: input.toSeq,
		editedBy: user.id,
		changeNote: input.changeNote,
	})
})

export const softDeleteArtifactCommand = command(z.string().uuid(), async (artifactId) => {
	const user = requireAuthenticatedRequestUser()
	await ensureArtifactOwned(artifactId, user.id)
	return softDeleteArtifact(artifactId)
})

// ─────────── Connections (was /source-control) ───────────

export const getProjectsOverviewQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [conns] = await Promise.all([listConnections(user.id)])
	return {
		githubConfigured: isGithubOAuthConfigured(),
		azureConfigured: isAzureDevOpsOAuthConfigured(),
		connections: conns.map((c) => ({
			id: c.id,
			provider: c.provider,
			providerAccount: c.providerAccount,
			scopes: c.scopes,
			status: c.status,
			lastSyncedAt: c.lastSyncedAt,
			lastError: c.lastError,
			updatedAt: c.updatedAt,
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

export const listGithubImportCandidatesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listGithubImportCandidates(user.id)
})

export const listAzureImportCandidatesQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [{ candidates, errorMessage }, conns] = await Promise.all([
		listAzureImportCandidates(user.id),
		listActiveAzureConnections(user.id),
	])
	return {
		candidates,
		errorMessage,
		orgs: conns.map((c) => c.providerAccount),
	}
})

// ─────────── Project repo controls (status / branches / commits / pull / push / commit / diff) ───────────

const projectIdSchema = z.object({ projectId: z.string().uuid() })

/**
 * One-stop snapshot for the Repo tab: working-tree status + sidecar repo metadata + recent
 * commits + branches + bound conversations + recent PRs. Replaces `getRepositoryDetailQuery`.
 */
export const getProjectRepoDetailQuery = query(projectIdSchema, async ({ projectId }) => {
	const user = requireAuthenticatedRequestUser()
	const project = await ensureProjectOwned(projectId, user.id)
	if (project.repoKind === 'none') {
		return {
			project,
			repository: null,
			status: null,
			branches: [],
			commits: [],
			pullRequests: [],
			conversations: [],
		}
	}

	const [repository] = await db
		.select()
		.from(repositories)
		.where(eq(repositories.projectId, projectId))
		.limit(1)

	const [statusResult, branchesResult, commitsResult, conversationsResult, pullRequestsResult] =
		await Promise.allSettled([
			getProjectStatus(user.id, projectId),
			listProjectBranches(user.id, projectId),
			listProjectCommits(user.id, projectId, { limit: 30 }),
			db
				.select({
					id: conversations.id,
					title: conversations.title,
					agentName: agents.name,
					updatedAt: conversations.updatedAt,
				})
				.from(conversations)
				.leftJoin(agents, eq(agents.id, conversations.agentId))
				.where(and(eq(conversations.userId, user.id), eq(conversations.projectId, projectId)))
				.orderBy(desc(conversations.updatedAt))
				.limit(10),
			repository ? listPullRequestsForRepository(repository.id) : Promise.resolve([]),
		])

	return {
		project,
		repository: repository
			? {
					id: repository.id,
					provider: repository.provider,
					owner: repository.owner,
					name: repository.name,
					cloneUrl: repository.cloneUrl,
					defaultBranch: repository.defaultBranch,
					metadata: repository.metadata,
				}
			: null,
		status: statusResult.status === 'fulfilled' ? statusResult.value : null,
		branches: branchesResult.status === 'fulfilled' ? branchesResult.value : [],
		commits: commitsResult.status === 'fulfilled' ? commitsResult.value : [],
		conversations: conversationsResult.status === 'fulfilled' ? conversationsResult.value : [],
		pullRequests:
			pullRequestsResult.status === 'fulfilled'
				? pullRequestsResult.value.map((pr) => ({
						id: pr.id,
						providerPrNumber: pr.providerPrNumber,
						title: pr.title,
						status: pr.status,
						headBranch: pr.headBranch,
						baseBranch: pr.baseBranch,
						providerUrl: pr.providerUrl,
						updatedAt: pr.updatedAt,
					}))
				: [],
	}
})

export const pullProjectCommand = command(projectIdSchema, async ({ projectId }) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(projectId, user.id)
	return pullProject(user.id, projectId)
})

const commitSchema = z.object({
	projectId: z.string().uuid(),
	message: z.string().trim().min(1).max(2000),
	paths: z.array(z.string().trim().min(1).max(500)).optional(),
})
export const commitProjectCommand = command(commitSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	return commitProject(user.id, input.projectId, { message: input.message, paths: input.paths })
})

const pushSchema = z.object({
	projectId: z.string().uuid(),
	branch: z.string().trim().min(1).max(200),
	force: z.boolean().optional(),
})
export const pushProjectBranchCommand = command(pushSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	const result = await pushProjectBranch(user.id, input.projectId, {
		branch: input.branch,
		force: input.force,
	})
	return {
		success: result.success,
		branch: result.branch,
		remote: result.remote,
		stderr: result.stderr,
		stdout: result.stdout,
		exitCode: result.exitCode,
	}
})

const branchCreateSchema = z.object({
	projectId: z.string().uuid(),
	name: z.string().trim().min(1).max(200),
	from: z.string().trim().min(1).max(200).optional(),
})
export const createProjectBranchCommand = command(branchCreateSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	return createProjectBranch(user.id, input.projectId, { name: input.name, from: input.from })
})

const branchSwitchSchema = z.object({
	projectId: z.string().uuid(),
	name: z.string().trim().min(1).max(200),
})
export const switchProjectBranchCommand = command(branchSwitchSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	return switchProjectBranch(user.id, input.projectId, input.name)
})

const diffSchema = z.object({
	projectId: z.string().uuid(),
	ref: z.string().trim().min(1).max(200).optional(),
})
export const getProjectDiffQuery = query(diffSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await ensureProjectOwned(input.projectId, user.id)
	return getProjectDiff(user.id, input.projectId, { ref: input.ref })
})
