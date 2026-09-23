import type { FileEditDetails } from '../engine/tool-result-details'

/**
 * #14 — the rail's Files tab: every file the agent changed in this chat.
 *
 * Nothing here asks the workspace or git. An `Edit` / `MultiEdit` / `Write` already arrives
 * carrying its path and +/- counts (`FileEditDetails`, distilled in
 * `$lib/engine/tool-result-details`), and those details are stored on the tool block twice
 * over: in `messages.metadata.blocks` for saved replies and in the page's live
 * `streamingBlocks` while a turn runs. So "what changed" is a fold over blocks the chat page
 * already holds. That also keeps the tab honest in a sandbox workspace that is not a git
 * repository, which is most of them — a git-status tab would be empty there.
 *
 * Pure and dependency-free (only `import type`), so the spec runs it in the plain
 * Playwright loader, like `tool-result-details`.
 */

export type ChangedFile = {
	/** The path as the agent last wrote it — what clicking the row opens in Preview. */
	path: string
	/** Last path segment, the row's main text. */
	name: string
	/** Everything before `name`, shown dimmed. Empty for a bare file name. */
	dir: string
	/** `create` when any edit in this chat created the file, otherwise `update`. */
	changeType: 'create' | 'update'
	additions: number
	deletions: number
	/** How many edits touched the file. */
	edits: number
}

/**
 * The part of a tool block this reads. Saved blocks (`success`) and live ones (`id`,
 * `status`) both fit, and anything else on them is ignored.
 */
export type ChangedFileSourceBlock = {
	kind?: unknown
	id?: unknown
	details?: unknown
	success?: unknown
	status?: unknown
}

type BlockList = ReadonlyArray<ChangedFileSourceBlock | null | undefined>

function isFileEdit(details: unknown): details is FileEditDetails {
	if (!details || typeof details !== 'object') return false
	const d = details as Partial<FileEditDetails>
	return d.kind === 'file_edit' && typeof d.path === 'string' && d.path.trim().length > 0
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** A call that failed or was refused changed nothing, whatever its details say. */
function failed(block: ChangedFileSourceBlock): boolean {
	return block.success === false || block.status === 'failed' || block.status === 'denied'
}

/** One key per file however the separators were written, so `a\b.ts` and `a/b.ts` merge. */
function keyOf(path: string): string {
	return path.trim().replace(/\\/g, '/')
}

function splitPath(path: string): { name: string; dir: string } {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
	return cut >= 0 ? { name: path.slice(cut + 1), dir: path.slice(0, cut + 1) } : { name: path, dir: '' }
}

/**
 * Fold tool blocks into one row per changed file, most recently changed first.
 *
 * - Lists are read in order, oldest first: saved messages by sequence, then the live turn.
 * - A block with an `id` is counted once even when two lists hold it.
 * - Only successful `file_edit` blocks count; a write that changed nothing
 *   (`unavailable: 'no_change'`) is not a change.
 * - Counts add up across edits, and a file created at any point stays `create`.
 */
export function collectChangedFiles(blockLists: Iterable<BlockList | null | undefined>): ChangedFile[] {
	const seenIds = new Set<string>()
	const byKey = new Map<string, ChangedFile & { order: number }>()
	let order = 0

	for (const list of blockLists) {
		if (!Array.isArray(list)) continue
		for (const block of list) {
			if (!block || typeof block !== 'object' || block.kind !== 'tool') continue
			if (typeof block.id === 'string' && block.id) {
				if (seenIds.has(block.id)) continue
				seenIds.add(block.id)
			}
			if (failed(block) || !isFileEdit(block.details)) continue
			const details = block.details
			if (details.unavailable === 'no_change') continue

			order += 1
			const path = details.path.trim()
			const key = keyOf(path)
			const existing = byKey.get(key)
			const created = details.changeType === 'create'
			if (existing) {
				existing.path = path
				Object.assign(existing, splitPath(path))
				existing.additions += count(details.additions)
				existing.deletions += count(details.deletions)
				existing.edits += 1
				if (created) existing.changeType = 'create'
				existing.order = order
			} else {
				byKey.set(key, {
					path,
					...splitPath(path),
					changeType: created ? 'create' : 'update',
					additions: count(details.additions),
					deletions: count(details.deletions),
					edits: 1,
					order,
				})
			}
		}
	}

	return [...byKey.values()]
		.sort((a, b) => b.order - a.order)
		.map(({ order: _order, ...file }) => file)
}

/** The fields of a chat message this reads: its id, and the blocks saved on its metadata. */
export type ChangedFileSourceMessage = { id: string; metadata?: unknown }

function savedBlocks(message: ChangedFileSourceMessage): BlockList | null {
	const metadata = message.metadata
	if (!metadata || typeof metadata !== 'object') return null
	const blocks = (metadata as { blocks?: unknown }).blocks
	return Array.isArray(blocks) ? (blocks as BlockList) : null
}

/**
 * The files the thread on screen shows edit cards for: every saved message, plus the turn
 * that is streaming.
 *
 * Saved blocks carry no id, so the id check in `collectChangedFiles` cannot tell that the
 * live turn and the message it was saved as are the same edits. `liveMessageId` can: once
 * the stream has named the message it saved and that message has loaded, the live blocks
 * are already counted through it and are left out.
 */
export function changedFilesInThread(input: {
	messages: ReadonlyArray<ChangedFileSourceMessage>
	liveBlocks: BlockList
	liveMessageId: string | null
}): ChangedFile[] {
	const saved = input.messages.map(savedBlocks)
	const liveSaved = input.liveMessageId !== null && input.messages.some((m) => m.id === input.liveMessageId)
	return collectChangedFiles(liveSaved ? saved : [...saved, input.liveBlocks])
}
