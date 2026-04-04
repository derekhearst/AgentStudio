import { json, type RequestHandler } from '@sveltejs/kit'
import { randomUUID } from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { env } from '$env/dynamic/private'

const UPLOAD_DIR = env.UPLOAD_DIR || './uploads'
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
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

	if (file.size > MAX_FILE_SIZE) {
		return json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, { status: 400 })
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
