import { error, type RequestHandler } from '@sveltejs/kit'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { env } from '$env/dynamic/private'

const UPLOAD_DIR = env.UPLOAD_DIR || './uploads'

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
}

export const GET: RequestHandler = async ({ params }) => {
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
			'Cache-Control': 'public, max-age=31536000, immutable',
		},
	})
}
