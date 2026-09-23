import { json, type RequestHandler } from '@sveltejs/kit'
import { randomUUID } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getUploadDir } from '$lib/server/config'
import { bodyTooLargeMessage, isBodyTooLarge } from '$lib/server/body-limit'

/**
 * Chat attachment uploads.
 *
 * The `locals.user` check below is defence in depth, not a hole being closed. These two
 * handlers read no `locals.user` at all, which looks alarming and is not: `hooks.server.ts`
 * redirects every unauthenticated request whose path is not in `PUBLIC_PATH_PREFIXES`, and
 * `/api/upload` is not in it. Verified rather than reasoned about — an anonymous POST here
 * answers `303 → /login`, and nothing reaches the filesystem.
 *
 * What the check buys is that the guarantee stops depending on a list in another file. A
 * `/api` entry added to `PUBLIC_PATH_PREFIXES` for some future public endpoint would open
 * this one silently, and an endpoint that writes 20MB (100MB for video) to disk per call
 * should not be one edit away from anonymous. The companion `GET /api/upload/[filename]`
 * carries the same check for the same reason: a filename is a bearer capability and nothing
 * records who uploaded what, so a name that leaks is the whole file.
 *
 * Session checks, not per-file ownership — nothing in the schema says who owns an upload,
 * and inventing that is a migration rather than a fix.
 */

const UPLOAD_DIR = getUploadDir()
const MAX_FILE_SIZE_DEFAULT = 20 * 1024 * 1024 // 20 MB
const MAX_FILE_SIZE_VIDEO = 100 * 1024 * 1024 // 100 MB for video
const ALLOWED_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'application/pdf',
	'text/plain',
	'text/csv',
	'application/json',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'video/mp4',
	'video/mpeg',
	'video/webm',
	'video/quicktime',
])

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })

	let formData: FormData
	try {
		formData = await request.formData()
	} catch (error) {
		// adapter-node refuses a body over BODY_SIZE_LIMIT before this runs, and the refusal
		// arrives here as a failed read. Say so, with the real limit — it is below the 100MB
		// video allowance unless the operator raised it ($lib/server/body-limit).
		if (isBodyTooLarge(error, request)) return json({ error: bodyTooLargeMessage() }, { status: 413 })
		return json({ error: 'Expected a multipart upload' }, { status: 400 })
	}
	const file = formData.get('file') as File | null
	if (!file) {
		return json({ error: 'No file provided' }, { status: 400 })
	}

	if (!ALLOWED_TYPES.has(file.type)) {
		return json({ error: `Unsupported file type: ${file.type}` }, { status: 400 })
	}

	const sizeLimit = file.type.startsWith('video/') ? MAX_FILE_SIZE_VIDEO : MAX_FILE_SIZE_DEFAULT
	if (file.size > sizeLimit) {
		return json({ error: `File too large (max ${sizeLimit / 1024 / 1024}MB)` }, { status: 400 })
	}

	const id = randomUUID()
	const ext = file.name.split('.').pop() || 'bin'
	const safeFilename = `${id}.${ext.replace(/[^a-zA-Z0-9]/g, '')}`

	await mkdir(UPLOAD_DIR, { recursive: true })
	const filePath = join(UPLOAD_DIR, safeFilename)
	const buffer = Buffer.from(await file.arrayBuffer())
	await writeFile(filePath, buffer)

	const attachment = {
		id,
		filename: file.name,
		mimeType: file.type,
		size: file.size,
		url: `/api/upload/${safeFilename}`,
	}

	return json(attachment)
}
