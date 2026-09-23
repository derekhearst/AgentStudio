/**
 * Real filesystem wiring for `attachments.server.ts`.
 *
 * Kept apart from the prompt builder so the builder stays importable (and
 * testable) without a sandbox root, an upload directory or a run.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { getUploadDir } from '$lib/server/config'
import { ensureWorkspace, safePathWithin, type WorkspaceContext } from '$lib/workspace/workspace.server'
import type { AttachmentIo, ChatAttachment } from './attachments.server'

/** Directory inside the run workspace where message attachments land. */
export const ATTACHMENT_DIR = 'attachments'

/**
 * Map an attachment URL back to the file the upload endpoint wrote.
 *
 * Attachments are always `/api/upload/<safeFilename>` (see
 * `src/routes/api/upload/+server.ts`), and the filename is minted server-side
 * as `<uuid>.<sanitized-ext>`. Anything else is refused rather than guessed at,
 * so a hand-crafted payload can't walk out of the upload directory.
 */
export function resolveUploadPath(url: string): string {
	const withoutQuery = url.split('?')[0] ?? ''
	if (!withoutQuery.startsWith('/api/upload/')) {
		throw new Error(`unsupported attachment url: ${url}`)
	}
	const name = withoutQuery.slice('/api/upload/'.length)
	if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
		throw new Error(`unsupported attachment filename: ${name}`)
	}
	return join(getUploadDir(), basename(name))
}

/** Strip a filename down to something safe to create inside the workspace. */
export function safeAttachmentName(attachment: ChatAttachment): string {
	const raw = basename(attachment.filename ?? '').trim()
	const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
	const short = attachment.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) || 'file'
	return cleaned ? `${short}-${cleaned}` : short
}

/**
 * Build the IO seam for one run.
 *
 * `workspace` is the run's context as `resolveRunWorkspace` produced it — sandbox root
 * included — so the path handed to the model is exactly the path `Read` opens, the
 * containment guard allows, and the SDK's working directory resolves. It used to rebuild
 * the context here from its own `process.env` read while the guard's copy had none, and the
 * two disagreed about where the workspace was.
 */
export function createAttachmentIo(workspace: WorkspaceContext): AttachmentIo {
	return {
		read: async (attachment) => readFile(resolveUploadPath(attachment.url)),
		stage: async (attachment, bytes) => {
			const root = await ensureWorkspace(workspace)
			const relative = `${ATTACHMENT_DIR}/${safeAttachmentName(attachment)}`
			const full = safePathWithin(root, relative)
			await mkdir(dirname(full), { recursive: true })
			await writeFile(full, bytes)
			// Tools take posix-style relative paths; on Windows `join` would hand
			// back backslashes the sandbox resolver then treats as one segment.
			return relative.split(sep).join('/')
		},
	}
}
