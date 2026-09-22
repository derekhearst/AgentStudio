import { error, type RequestHandler } from '@sveltejs/kit'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { getUploadDir } from '$lib/server/config'

const UPLOAD_DIR = getUploadDir()

const MIME_MAP: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
	txt: 'text/plain',
	csv: 'text/csv',
	json: 'application/json',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mpeg: 'video/mpeg',
	mpg: 'video/mpeg',
}

/**
 * Serve an uploaded attachment.
 *
 * The session check is defence in depth, for the reason given in `../+server.ts`: the
 * global hook already redirects anonymous requests to this path, and this makes that
 * guarantee independent of `PUBLIC_PATH_PREFIXES`. Every real consumer is a same-origin
 * `<img>` or `fetch` from a signed-in page, which carries the cookie; the server-side
 * readers go through the filesystem (`resolveUploadPath`), not HTTP, so none is affected.
 *
 * The `Cache-Control` change below is a real fix rather than a belt-and-braces one. This
 * response has always required a session — the hook saw to that — so advertising it as
 * `public` was already wrong: a shared cache is entitled to keep a `public` response and
 * serve it to a different, unauthenticated request.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized')

	const filename = params.filename
	if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
		throw error(400, 'Invalid filename')
	}

	const filePath = join(UPLOAD_DIR, filename)

	try {
		await stat(filePath)
	} catch {
		throw error(404, 'File not found')
	}

	const buffer = await readFile(filePath)
	const ext = filename.split('.').pop()?.toLowerCase() || ''
	const contentType = MIME_MAP[ext] || 'application/octet-stream'

	return new Response(buffer, {
		headers: {
			'Content-Type': contentType,
			// `private`, not `public`: this response depends on a session cookie, so a shared
			// cache must not keep it and hand it to the next request.
			'Cache-Control': 'private, max-age=31536000, immutable',
		},
	})
}
