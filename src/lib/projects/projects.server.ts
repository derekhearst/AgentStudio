import { and, asc, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	artifactVersions,
	artifacts,
	projects,
	type ArtifactContentType,
	type ArtifactRow,
	type ArtifactVersionRow,
	type ProjectKind,
	type ProjectRow,
	type RepoKind,
} from './projects.schema'
import { repositories, type RepositoryRow } from '$lib/source-control/source-control.schema'
import { logger } from '$lib/observability/logger'
import { cloneIntoProject, deleteProjectFs, initLocalProjectRepo } from './project-fs.server'
import { credentialUsernameForProvider, parseCloneUrl } from '$lib/source-control/parse-clone-url'
import { getActiveAzureConnection, getActiveGithubConnection } from '$lib/source-control/source-control.server'

/**
 * Wave 4 #15 phase 1 — projects + artifacts + version helpers.
 *
 * All operations are user-scoped — listProjects/createProject etc. take a `userId` and the
 * remote layer enforces it. Slug generation is automatic + collision-resilient (appends `-2`,
 * `-3` etc. on conflict). Artifact versions are append-only — even rollback creates a NEW
 * version row that copies the target seq's content forward.
 */

// ─────────── Slug helpers ───────────

const SLUG_SAFE_CHARS = /[^a-z0-9-]/g
const MULTI_DASH = /-+/g

export function slugify(input: string): string {
	const base = input
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(SLUG_SAFE_CHARS, '')
		.replace(MULTI_DASH, '-')
		.replace(/^-+|-+$/g, '')
	return base.length > 0 ? base.slice(0, 64) : 'untitled'
}

async function uniqueProjectSlug(userId: string | null, baseSlug: string): Promise<string> {
	const existing = await db
		.select({ slug: projects.slug })
		.from(projects)
		.where(userId === null ? drizzleSql`${projects.userId} is null` : eq(projects.userId, userId))
	const taken = new Set(existing.map((r) => r.slug))
	if (!taken.has(baseSlug)) return baseSlug
	for (let i = 2; i < 1000; i++) {
		const candidate = `${baseSlug}-${i}`
		if (!taken.has(candidate)) return candidate
	}
	throw new Error(`unable to find a unique slug for "${baseSlug}" after 1000 attempts`)
}

async function uniqueArtifactSlug(
	scope: { projectId: string } | { conversationId: string },
	baseSlug: string,
): Promise<string> {
	const where =
		'projectId' in scope
			? eq(artifacts.projectId, scope.projectId)
			: eq(artifacts.conversationId, scope.conversationId)
	const existing = await db.select({ slug: artifacts.slug }).from(artifacts).where(where)
	const taken = new Set(existing.map((r) => r.slug))
	if (!taken.has(baseSlug)) return baseSlug
	for (let i = 2; i < 1000; i++) {
		const candidate = `${baseSlug}-${i}`
		if (!taken.has(candidate)) return candidate
	}
	throw new Error(`unable to find a unique slug for "${baseSlug}" after 1000 attempts`)
}

// ─────────── Project CRUD ───────────

export type GithubSource = { type: 'github'; owner: string; repo: string; cloneUrl: string }
export type AzureSource = {
	type: 'azure'
	org: string
	project: string
	repo: string
	cloneUrl: string
}
export type UrlSource = { type: 'url'; cloneUrl: string }
export type ImportSource = GithubSource | AzureSource | UrlSource

export type CreateProjectInput = {
	userId: string
	name: string
	description?: string | null
	kind?: ProjectKind
	slug?: string
	/**
	 * Filesystem mode for the project. 'none' (legacy) skips fs entirely; 'local' git-init's
	 * an empty repo at the project's sandbox path; 'imported' clones from a remote and
	 * inserts a sidecar `repositories` row to remember provider/owner/name/cloneUrl.
	 */
	repoMode?: RepoKind
	defaultBranch?: string
	source?: ImportSource
}

export type CreateProjectResult = {
	project: ProjectRow
	repository: RepositoryRow | null
	fsPath: string | null
}

/**
 * Create a project. Three flows depending on `repoMode`:
 *   'none'     — DB row only, no fs footprint, no sidecar.
 *   'local'    — DB row + `git init`'d sandbox path (README + initial commit).
 *   'imported' — DB row + `repositories` sidecar + cloned sandbox path.
 *
 * Filesystem operations happen AFTER the DB transaction commits, so a failed clone
 * triggers a compensating row delete + fs cleanup. The non-transactional approach is
 * deliberate: holding a DB transaction open across a 30-second clone is a footgun, and
 * we'd rather absorb the rare orphaned-row case (cleaned up by the catch handler) than
 * tie up a connection.
 */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
	const repoMode: RepoKind = input.repoMode ?? 'none'
	const baseSlug = input.slug ? slugify(input.slug) : slugify(input.name)
	const slug = await uniqueProjectSlug(input.userId, baseSlug)

	const [row] = await db
		.insert(projects)
		.values({
			userId: input.userId,
			name: input.name,
			slug,
			description: input.description ?? null,
			kind: input.kind ?? 'other',
			repoKind: repoMode,
		})
		.returning()

	if (repoMode === 'none') {
		return { project: row, repository: null, fsPath: null }
	}

	if (repoMode === 'local') {
		try {
			const { path, branch } = await initLocalProjectRepo({
				userId: input.userId,
				projectId: row.id,
				defaultBranch: input.defaultBranch,
				projectName: input.name,
			})
			const [updated] = await db
				.update(projects)
				.set({ repoLocalPath: path, defaultBranch: branch, updatedAt: new Date() })
				.where(eq(projects.id, row.id))
				.returning()
			return { project: updated, repository: null, fsPath: path }
		} catch (err) {
			logger.warn('[projects] local repo init failed; rolling back project row', { err })
			await db.delete(projects).where(eq(projects.id, row.id))
			throw err
		}
	}

	// repoMode === 'imported'
	if (!input.source) {
		await db.delete(projects).where(eq(projects.id, row.id))
		throw new Error('createProject: imported mode requires a `source` field')
	}

	try {
		return await importIntoProject(row, input.userId, input.source)
	} catch (err) {
		logger.warn('[projects] import failed; rolling back project row + fs', { err })
		await deleteProjectFs(input.userId, row.id).catch(() => {})
		await db.delete(projects).where(eq(projects.id, row.id))
		throw err
	}
}

async function importIntoProject(
	row: ProjectRow,
	userId: string,
	source: ImportSource,
): Promise<CreateProjectResult> {
	// Resolve provider, identity, and credentials from the discriminated source union.
	let provider: 'github' | 'azure_devops' | 'local'
	let owner: string
	let name: string
	let cloneUrl: string
	let token = ''
	let credentialUsername: string | undefined
	let providerMetadata: Record<string, unknown> = {}

	if (source.type === 'github') {
		provider = 'github'
		owner = source.owner
		name = source.repo
		cloneUrl = source.cloneUrl
		const conn = await getActiveGithubConnection(userId)
		if (!conn) {
			throw new Error('GitHub connection unavailable. Connect GitHub at /projects before importing private repos.')
		}
		token = conn.accessToken
		credentialUsername = 'x-access-token'
		providerMetadata = { htmlUrl: `https://github.com/${owner}/${name}` }
	} else if (source.type === 'azure') {
		provider = 'azure_devops'
		owner = source.org
		name = source.repo
		cloneUrl = source.cloneUrl
		const conn = await getActiveAzureConnection(userId, source.org)
		if (conn) {
			token = conn.accessToken
			credentialUsername = 'oauth2'
		}
		providerMetadata = {
			htmlUrl: cloneUrl,
			azure: { org: source.org, project: source.project, repo: source.repo },
		}
	} else {
		// URL paste — defer to the parser to figure out what it is.
		const parsed = parseCloneUrl(source.cloneUrl)
		provider = parsed.provider === 'github' ? 'github' : parsed.provider === 'azure_devops' ? 'azure_devops' : 'local'
		cloneUrl = parsed.cloneUrl
		credentialUsername = credentialUsernameForProvider(provider)
		if (parsed.provider === 'github') {
			owner = parsed.owner
			name = parsed.repo
			const conn = await getActiveGithubConnection(userId)
			if (conn) {
				token = conn.accessToken
				credentialUsername = 'x-access-token'
			}
			providerMetadata = { htmlUrl: parsed.htmlUrl }
		} else if (parsed.provider === 'azure_devops') {
			owner = parsed.org
			name = parsed.repo
			const conn = await getActiveAzureConnection(userId, parsed.org)
			if (conn) {
				token = conn.accessToken
				credentialUsername = 'oauth2'
			}
			providerMetadata = {
				htmlUrl: parsed.htmlUrl,
				azure: { org: parsed.org, project: parsed.project, repo: parsed.repo },
			}
		} else {
			owner = parsed.owner
			name = parsed.name
			providerMetadata = { htmlUrl: parsed.htmlUrl, host: parsed.host }
			credentialUsername = ''
		}
	}

	const cloneResult = await cloneIntoProject({
		userId,
		projectId: row.id,
		cloneUrl,
		token: token || undefined,
		credentialUsername,
	})

	const now = new Date()
	const [updated] = await db
		.update(projects)
		.set({
			repoLocalPath: cloneResult.path,
			defaultBranch: cloneResult.branch,
			lastImportedAt: now,
			updatedAt: now,
		})
		.where(eq(projects.id, row.id))
		.returning()

	const [repository] = await db
		.insert(repositories)
		.values({
			userId,
			provider,
			owner,
			name,
			cloneUrl,
			defaultBranch: cloneResult.branch,
			projectId: row.id,
			metadata: { ...providerMetadata, localPath: cloneResult.path, lastImportedAt: now.toISOString() },
		})
		.returning()

	return { project: updated, repository, fsPath: cloneResult.path }
}

export async function listProjects(userId: string): Promise<ProjectRow[]> {
	return db
		.select()
		.from(projects)
		.where(eq(projects.userId, userId))
		.orderBy(desc(projects.updatedAt))
}

export async function getProjectById(projectId: string): Promise<ProjectRow | null> {
	const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	return row ?? null
}

export async function getProjectBySlug(userId: string, slug: string): Promise<ProjectRow | null> {
	const [row] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.userId, userId), eq(projects.slug, slug)))
		.limit(1)
	return row ?? null
}

export async function updateProject(
	projectId: string,
	patch: { name?: string; description?: string | null; kind?: ProjectKind },
): Promise<ProjectRow | null> {
	const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() }
	if (patch.name !== undefined) updates.name = patch.name
	if (patch.description !== undefined) updates.description = patch.description
	if (patch.kind !== undefined) updates.kind = patch.kind
	const [row] = await db.update(projects).set(updates).where(eq(projects.id, projectId)).returning()
	return row ?? null
}

export async function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
	// Read the row first so we know whether (and where) to clean up the filesystem after the
	// cascade-delete completes.
	const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
	if (!row) return { deleted: false }

	// Cascade trims artifacts + versions automatically via FK.
	// `repositories` has its FK to `projects` declared by-name (not enforced) — clear the
	// sidecar row explicitly so PRs/branches/checks cascade off it.
	await db.delete(repositories).where(eq(repositories.projectId, projectId))
	const result = await db.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id })

	if (result.length > 0 && row.userId && row.repoKind !== 'none') {
		await deleteProjectFs(row.userId, projectId).catch((err) =>
			logger.warn('[projects] deleteProjectFs failed (non-fatal)', { projectId, err }),
		)
	}

	return { deleted: result.length > 0 }
}

// ─────────── Artifact CRUD + versions ───────────

export type CreateArtifactInput = {
	projectId?: string | null
	conversationId?: string | null
	name: string
	content: string
	contentType?: ArtifactContentType
	changeNote?: string | null
	editedBy?: string | null
	sourceRunId?: string | null
	costUsd?: number | string | null
}

export type ArtifactWithCurrent = ArtifactRow & {
	currentVersion: ArtifactVersionRow | null
}

/**
 * Create a new artifact, seeding it with version 1 in a single transaction so the artifact
 * never exists without its initial version. The artifact is scoped to either a project or a
 * conversation — exactly one must be supplied.
 */
export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactWithCurrent> {
	if ((input.projectId == null) === (input.conversationId == null)) {
		throw new Error('createArtifact: exactly one of projectId or conversationId must be set')
	}

	const baseSlug = slugify(input.name)
	const slug = await uniqueArtifactSlug(
		input.projectId ? { projectId: input.projectId } : { conversationId: input.conversationId! },
		baseSlug,
	)

	return db.transaction(async (tx) => {
		const [artifact] = await tx
			.insert(artifacts)
			.values({
				projectId: input.projectId ?? null,
				conversationId: input.conversationId ?? null,
				name: input.name,
				slug,
				contentType: input.contentType ?? 'markdown',
			})
			.returning()
		const [version] = await tx
			.insert(artifactVersions)
			.values({
				artifactId: artifact.id,
				seq: 1,
				content: input.content,
				changeNote: input.changeNote ?? null,
				editedBy: input.editedBy ?? null,
				sourceRunId: input.sourceRunId ?? null,
				costUsd: input.costUsd != null ? String(input.costUsd) : null,
			})
			.returning()
		const [updated] = await tx
			.update(artifacts)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(artifacts.id, artifact.id))
			.returning()
		return { ...updated, currentVersion: version }
	})
}

/**
 * List artifacts scoped to a conversation (lightweight in-chat plans/todos/docs).
 */
export async function listArtifactsForConversation(
	conversationId: string,
	opts: { includeInactive?: boolean } = {},
): Promise<ArtifactRow[]> {
	const filters = [eq(artifacts.conversationId, conversationId)]
	if (!opts.includeInactive) filters.push(eq(artifacts.isActive, true))
	return db
		.select()
		.from(artifacts)
		.where(and(...filters))
		.orderBy(desc(artifacts.updatedAt))
}

export type EditArtifactInput = {
	artifactId: string
	content: string
	changeNote?: string | null
	editedBy?: string | null
	sourceRunId?: string | null
	costUsd?: number | string | null
}

/**
 * Append a new version to an existing artifact. Computes `seq = previousMax + 1` and updates
 * the artifact's `currentVersionId` pointer in the same transaction. Preserves all prior
 * versions — append-only.
 */
export async function editArtifact(input: EditArtifactInput): Promise<ArtifactVersionRow | null> {
	return db.transaction(async (tx) => {
		const [maxSeq] = await tx
			.select({ max: drizzleSql<number>`coalesce(max(${artifactVersions.seq}), 0)::int` })
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, input.artifactId))
		const nextSeq = (maxSeq?.max ?? 0) + 1
		if (nextSeq === 1) {
			// Artifact has no versions yet — caller should be using createArtifact. Don't proceed.
			throw new Error(`editArtifact: artifact ${input.artifactId} has no existing version (use createArtifact)`)
		}
		const [version] = await tx
			.insert(artifactVersions)
			.values({
				artifactId: input.artifactId,
				seq: nextSeq,
				content: input.content,
				changeNote: input.changeNote ?? null,
				editedBy: input.editedBy ?? null,
				sourceRunId: input.sourceRunId ?? null,
				costUsd: input.costUsd != null ? String(input.costUsd) : null,
			})
			.returning()
		await tx
			.update(artifacts)
			.set({ currentVersionId: version.id, updatedAt: new Date() })
			.where(eq(artifacts.id, input.artifactId))
		return version
	})
}

export async function getArtifactById(artifactId: string): Promise<ArtifactWithCurrent | null> {
	const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
	if (!artifact) return null
	const [version] = artifact.currentVersionId
		? await db
				.select()
				.from(artifactVersions)
				.where(eq(artifactVersions.id, artifact.currentVersionId))
				.limit(1)
		: []
	return { ...artifact, currentVersion: version ?? null }
}

export async function listArtifactsForProject(
	projectId: string,
	opts: { includeInactive?: boolean } = {},
): Promise<ArtifactRow[]> {
	const filters = [eq(artifacts.projectId, projectId)]
	if (!opts.includeInactive) filters.push(eq(artifacts.isActive, true))
	return db
		.select()
		.from(artifacts)
		.where(and(...filters))
		.orderBy(desc(artifacts.updatedAt))
}

export async function getVersionHistory(artifactId: string): Promise<ArtifactVersionRow[]> {
	return db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(asc(artifactVersions.seq))
}

export async function getVersion(versionId: string): Promise<ArtifactVersionRow | null> {
	const [row] = await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.id, versionId))
		.limit(1)
	return row ?? null
}

/**
 * Non-destructive rollback: copies the target seq's content forward as a new version. The old
 * versions are preserved so the timeline reads "v1 → v2 → v3 (revert to v1) → v4".
 */
export async function rollbackArtifact(input: {
	artifactId: string
	toSeq: number
	editedBy?: string | null
	changeNote?: string | null
}): Promise<ArtifactVersionRow | null> {
	const [target] = await db
		.select()
		.from(artifactVersions)
		.where(and(eq(artifactVersions.artifactId, input.artifactId), eq(artifactVersions.seq, input.toSeq)))
		.limit(1)
	if (!target) return null
	return editArtifact({
		artifactId: input.artifactId,
		content: target.content,
		changeNote: input.changeNote ?? `Rollback to v${input.toSeq}`,
		editedBy: input.editedBy ?? null,
	})
}

/**
 * Soft-delete: marks an artifact as inactive. Versions are preserved; listArtifactsForProject
 * filters them out unless `includeInactive: true` is passed.
 */
export async function softDeleteArtifact(artifactId: string): Promise<{ deleted: boolean }> {
	const result = await db
		.update(artifacts)
		.set({ isActive: false, updatedAt: new Date() })
		.where(eq(artifacts.id, artifactId))
		.returning({ id: artifacts.id })
	return { deleted: result.length > 0 }
}
