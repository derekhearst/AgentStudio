import { json, type RequestHandler } from '@sveltejs/kit'
import { getProjectById } from '$lib/projects/projects.server'
import {
	MAX_KNOWLEDGE_FILE_BYTES,
	deleteKnowledgeFile,
	listKnowledgeFiles,
	saveKnowledgeFile,
} from '$lib/projects/project-knowledge.server'
import { logger } from '$lib/observability/logger'
import { bodyTooLargeMessage, isBodyTooLarge } from '$lib/server/body-limit'

/**
 * Upload and remove a project's knowledge files (#23).
 *
 * A route rather than a remote function because remote functions carry JSON and these are
 * arbitrary bytes. `/api/upload` is not reused: that endpoint writes to a shared upload
 * directory for chat attachments, and these belong *inside the project's working
 * directory*, which is the entire point — the agent reads them with the same `Read` and
 * `Grep` it uses for source.
 *
 * The body limit is the server's, not this route's: adapter-node refuses anything over
 * `BODY_SIZE_LIMIT` before the handler runs, so the production image sets it above
 * `MAX_KNOWLEDGE_FILE_BYTES` (see `$lib/server/body-limit`).
 *
 * Ownership is checked on every method before the filesystem is touched. The path helpers
 * derive everything from the authenticated user's id and the project id, so a caller who
 * knows a project id they do not own gets a 404 rather than somebody else's directory.
 */

async function requireOwnedProject(projectId: string | undefined, userId: string) {
	if (!projectId) return null
	const project = await getProjectById(projectId)
	if (!project || project.userId !== userId) return null
	return project
}

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })

	const project = await requireOwnedProject(params.id, locals.user.id)
	if (!project) return json({ error: 'Project not found' }, { status: 404 })

	let file: File | null = null
	try {
		const form = await request.formData()
		const entry = form.get('file')
		file = entry instanceof File ? entry : null
	} catch (error) {
		// The server refusing the size looks like a broken body from here. It used to be
		// reported as one, so every file over adapter-node's limit read as malformed.
		if (isBodyTooLarge(error, request)) return json({ error: bodyTooLargeMessage() }, { status: 413 })
		return json({ error: 'Expected a multipart upload' }, { status: 400 })
	}
	if (!file) return json({ error: 'No file provided' }, { status: 400 })

	// Checked before the bytes are read into memory as well as inside `saveKnowledgeFile`:
	// the limit is the module's to enforce, but there is no reason to buffer 200MB first.
	if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
		return json(
			{ error: `That file is larger than ${MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024}MB.` },
			{ status: 413 },
		)
	}

	try {
		const saved = await saveKnowledgeFile({
			userId: locals.user.id,
			projectId: project.id,
			filename: file.name,
			bytes: new Uint8Array(await file.arrayBuffer()),
		})
		return json({ file: saved })
	} catch (error) {
		// These messages are written for the operator — a refused extension, a full project,
		// an unusable name — so they are returned rather than flattened into a 500.
		const message = error instanceof Error ? error.message : 'Could not save that file'
		logger.warn('[projects/knowledge] upload refused', { projectId: project.id, error: message })
		return json({ error: message }, { status: 400 })
	}
}

export const DELETE: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })

	const project = await requireOwnedProject(params.id, locals.user.id)
	if (!project) return json({ error: 'Project not found' }, { status: 404 })

	const body = (await request.json().catch(() => null)) as { name?: string } | null
	if (!body?.name) return json({ error: 'name is required' }, { status: 400 })

	try {
		const deleted = await deleteKnowledgeFile(locals.user.id, project.id, body.name)
		return json({ deleted, files: await listKnowledgeFiles(locals.user.id, project.id) })
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Could not delete that file'
		return json({ error: message }, { status: 400 })
	}
}
