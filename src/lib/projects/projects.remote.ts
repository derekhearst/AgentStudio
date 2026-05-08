import { command, query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import {
	createArtifact,
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
} from './projects.server'

/**
 * Wave 4 #15 phase 1 — Projects + Artifacts SvelteKit remote surface.
 *
 * All queries/commands are user-scoped — every read enforces the project belongs to the
 * caller via `getProjectById` + ownership check. Slug generation is delegated to the server
 * layer so the same dedupe logic powers UI + tool-driven creation.
 */

const PROJECT_KIND_VALUES = ['efoil', 'research', 'code', 'documentation', 'other'] as const
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
		const { conversations } = await import('$lib/sessions/sessions.schema')
		const { eq } = await import('drizzle-orm')
		const { db } = await import('$lib/db.server')
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

const createProjectSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(1000).optional(),
	kind: z.enum(PROJECT_KIND_VALUES).optional(),
	slug: z.string().trim().min(1).max(64).optional(),
})

export const createProjectCommand = command(createProjectSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return createProject({
		userId: user.id,
		name: input.name,
		description: input.description ?? null,
		kind: input.kind,
		slug: input.slug,
	})
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
