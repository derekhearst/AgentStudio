import { json, type RequestHandler } from '@sveltejs/kit'
import { randomUUID } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getUploadDir } from '$lib/server/config'

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

export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData()
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
