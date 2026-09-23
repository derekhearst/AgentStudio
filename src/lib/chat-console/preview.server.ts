import { readdir, readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { extractAgentWorkspaceConfig } from '$lib/chat/stream-prep.server'
import { resolveWorkspaceRoot, safePathWithin } from '$lib/workspace/workspace.server'
import {
	baseName,
	classifyExtension,
	IMAGE_MIME,
	fileExtension,
	type PreviewFile,
	type PreviewPayload,
} from './preview-kinds'

/**
 * #29 — read-only file access for the rail preview.
 *
 * Containment is the whole point of this module. It resolves the *same*
 * workspace root that `sandbox.server.ts` hands to the agent's file tools, and
 * every path the client sends goes through `safePathWithin` against the user's
 * own sandbox subtree. There is no code path here that will open an arbitrary
 * absolute path: a path that resolves outside `<sandbox>/<userId>` throws.
 * "Resolves" includes symlinks — `safePathWithin` judges the path the OS will
 * really open, so `ln -s / root` in a workspace does not make `root/etc/passwd`
 * previewable. Directory listings skip symlinks entirely.
 */

/** Text files above this are served as a prefix, with `truncated: true`. */
const TEXT_MAX_BYTES = 512 * 1024
/** Binary files above this are refused outright rather than streamed. */
export const RAW_MAX_BYTES = 32 * 1024 * 1024
const MAX_DIR_ENTRIES = 300

export class PreviewError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'PreviewError'
	}
}

export type ConversationWorkspace = {
	/**
	 * Hard boundary: `<sandbox>/<userId>`. Every resolved path must live under
	 * this. It is the user's own tree, so run / project / persistent workspaces
	 * are all reachable, and nothing belonging to another user is.
	 */
	containmentRoot: string
	/** Where a *relative* path is resolved from first — the conversation's own workspace. */
	defaultRoot: string
}

/**
 * Rebuild the workspace the conversation's tools run in.
 *
 * Mirrors the priority order in `resolveWorkspaceRoot`: persistent key and
 * worktree come off the bound agent's config, project comes off the
 * conversation, and the bare run path uses the conversation's most recent run.
 */
export async function resolveConversationWorkspace(
	conversationId: string,
	userId: string,
): Promise<ConversationWorkspace> {
	const [conversation] = await db
		.select({ id: conversations.id, userId: conversations.userId, projectId: conversations.projectId, agentId: conversations.agentId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)

	if (!conversation) throw new PreviewError(404, 'Conversation not found')
	if (conversation.userId !== userId) throw new PreviewError(403, 'Not authorized')

	let agentConfig: unknown = null
	if (conversation.agentId) {
		const [agent] = await db
			.select({ config: agents.config })
			.from(agents)
			.where(eq(agents.id, conversation.agentId))
			.limit(1)
		agentConfig = agent?.config ?? null
	}
	const workspaceConfig = extractAgentWorkspaceConfig(agentConfig)

	const [latestRun] = await db
		.select({ id: chatRuns.id })
		.from(chatRuns)
		.where(eq(chatRuns.conversationId, conversationId))
		.orderBy(desc(chatRuns.createdAt))
		.limit(1)

	// `process.env.SANDBOX_WORKSPACE` (not `getSandboxRoot()`) on purpose — that is
	// exactly what `sandbox.server.ts` passes, including its undefined-means-
	// `/workspace/users` default. Using a different default here would point the
	// preview at a directory the agent never writes to.
	const sandboxRoot = process.env.SANDBOX_WORKSPACE

	const containmentRoot = resolveWorkspaceRoot({ userId, sandboxRoot })
	const defaultRoot = resolveWorkspaceRoot({
		userId,
		runId: latestRun?.id ?? null,
		persistentKey: workspaceConfig.persistentKey,
		worktree: workspaceConfig.worktreeConfig,
		projectId: conversation.projectId ?? null,
		sandboxRoot,
	})

	return { containmentRoot, defaultRoot }
}

function assertSaneInput(userPath: string) {
	if (!userPath || userPath.length > 2048) throw new PreviewError(400, 'Invalid path')
	// A NUL byte truncates the path at the syscall boundary on some platforms.
	if (userPath.includes('\0')) throw new PreviewError(400, 'Invalid path')
}

/**
 * Turn a client-supplied path into an absolute path inside the user's sandbox.
 *
 * Relative paths are tried against the conversation workspace first, then the
 * user root — a file written during an earlier run still previews. Both
 * candidates are validated against `containmentRoot`, so the fallback widens
 * *where we look*, never *what we are allowed to open*.
 */
export async function resolvePreviewPath(
	workspace: ConversationWorkspace,
	userPath: string,
): Promise<{ absolute: string; display: string }> {
	assertSaneInput(userPath)
	const cleaned = userPath.trim().replace(/^file:\/\//i, '')

	const candidates: string[] = []
	for (const root of [workspace.defaultRoot, workspace.containmentRoot]) {
		let absolute: string
		try {
			absolute = safePathWithin(workspace.containmentRoot, resolve(root, cleaned))
		} catch {
			continue
		}
		if (!candidates.includes(absolute)) candidates.push(absolute)
	}

	if (candidates.length === 0) throw new PreviewError(403, 'Path is outside this chat’s workspace')

	for (const absolute of candidates) {
		try {
			await stat(absolute)
			return { absolute, display: toDisplayPath(workspace, absolute) }
		} catch {
			// try the next candidate
		}
	}

	throw new PreviewError(404, `Not found: ${cleaned}`)
}

function toDisplayPath(workspace: ConversationWorkspace, absolute: string): string {
	for (const root of [workspace.defaultRoot, workspace.containmentRoot]) {
		const rel = relative(root, absolute)
		if (rel && !rel.startsWith('..') && !rel.startsWith(sep)) return rel.split(sep).join('/')
	}
	return absolute.split(sep).join('/')
}

/** Cheap binary sniff — a NUL in the first 8 KiB means "don't render this as text". */
function looksBinary(buffer: Buffer): boolean {
	const limit = Math.min(buffer.length, 8192)
	for (let i = 0; i < limit; i++) {
		if (buffer[i] === 0) return true
	}
	return false
}

export async function buildPreviewPayload(
	workspace: ConversationWorkspace,
	userPath: string,
	rawUrlFor: (displayPath: string) => string,
): Promise<PreviewPayload> {
	const { absolute, display } = await resolvePreviewPath(workspace, userPath)
	const info = await stat(absolute)

	if (info.isDirectory()) {
		const raw = await readdir(absolute, { withFileTypes: true })
		const sorted = raw
			.filter((e) => e.isDirectory() || e.isFile())
			.sort((a, b) => {
				if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
				return a.name.localeCompare(b.name)
			})
		const entries = await Promise.all(
			sorted.slice(0, MAX_DIR_ENTRIES).map(async (entry) => {
				const childPath = display ? `${display}/${entry.name}` : entry.name
				let size = 0
				if (entry.isFile()) {
					try {
						size = (await stat(resolve(absolute, entry.name))).size
					} catch {
						size = 0
					}
				}
				return { name: entry.name, path: childPath, isDirectory: entry.isDirectory(), size }
			}),
		)
		return {
			kind: 'directory',
			path: display,
			name: baseName(display) || display || '/',
			entries,
			truncated: sorted.length > MAX_DIR_ENTRIES,
		}
	}

	if (!info.isFile()) throw new PreviewError(415, 'Not a regular file')

	const base: Omit<PreviewFile, 'kind' | 'language' | 'content' | 'truncated' | 'rawUrl' | 'note'> = {
		path: display,
		name: baseName(display),
		size: info.size,
		modifiedAt: info.mtime?.toISOString() ?? null,
	}

	const classification = classifyExtension(display)

	if (classification.kind === 'image' || classification.kind === 'pdf') {
		if (info.size > RAW_MAX_BYTES) {
			return {
				...base,
				kind: 'binary',
				language: null,
				content: null,
				truncated: false,
				rawUrl: null,
				note: `Too large to preview (${info.size} bytes).`,
			}
		}
		return {
			...base,
			kind: classification.kind,
			language: null,
			content: null,
			truncated: false,
			rawUrl: rawUrlFor(display),
			note: null,
		}
	}

	const buffer = await readFile(absolute)
	if (looksBinary(buffer)) {
		return {
			...base,
			kind: 'binary',
			language: null,
			content: null,
			truncated: false,
			rawUrl: null,
			note: 'Binary file — not rendered.',
		}
	}

	const truncated = buffer.length > TEXT_MAX_BYTES
	const content = buffer.subarray(0, TEXT_MAX_BYTES).toString('utf8')

	return {
		...base,
		kind: classification.kind === 'markdown' ? 'markdown' : classification.kind === 'code' ? 'code' : 'text',
		language: classification.kind === 'code' ? classification.language : null,
		content,
		truncated,
		rawUrl: null,
		note: null,
	}
}

/**
 * Bytes for the `<img>` / `<iframe>` tags.
 *
 * Only images and PDFs. Serving arbitrary workspace HTML or SVG from our own
 * origin would hand an agent-written (and therefore attacker-influenceable)
 * file same-origin script execution, so anything else is refused here and read
 * as text through `buildPreviewPayload` instead.
 */
export async function readRawBytes(
	workspace: ConversationWorkspace,
	userPath: string,
): Promise<{ body: Buffer; contentType: string; filename: string; sandboxed: boolean }> {
	const { absolute, display } = await resolvePreviewPath(workspace, userPath)
	const info = await stat(absolute)
	if (!info.isFile()) throw new PreviewError(415, 'Not a regular file')
	if (info.size > RAW_MAX_BYTES) throw new PreviewError(413, 'File too large to preview')

	const ext = fileExtension(display)
	const imageMime = IMAGE_MIME[ext]
	if (imageMime) {
		return { body: await readFile(absolute), contentType: imageMime, filename: baseName(display), sandboxed: true }
	}
	if (ext === 'pdf') {
		// No CSP sandbox here: the browser's built-in PDF viewer is the cheap way to
		// get paging, and a `sandbox` directive disables it. PDF script execution is
		// confined to the viewer's own sandbox and cannot touch our DOM.
		return { body: await readFile(absolute), contentType: 'application/pdf', filename: baseName(display), sandboxed: false }
	}

	throw new PreviewError(415, 'Only images and PDFs are served as raw bytes')
}
