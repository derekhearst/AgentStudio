import { safePathWithin, workspaceCarriesOver } from '$lib/workspace/workspace.server'
import { rankPaths, type MentionSearchResult } from '$lib/chat/mention-match'
import { MAX_TRIGGER_QUERY } from '$lib/chat/composer-trigger'
import { PreviewError, resolveConversationWorkspace } from './preview.server'
import { getWorkspaceFileIndex } from './workspace-files.server'

/**
 * #22 — the `@` search: files in the directory this conversation's next turn will run in.
 *
 * Which directory, and when there is none:
 *
 * - A chat bound to a project: the project's checkout.
 * - A chat whose agent keeps a persistent workspace: that workspace.
 * - Anything else starts every turn in a fresh folder (a new `runs/<id>` directory, or a new
 *   git worktree), so there is nothing to mention ahead of time — a file the last turn wrote
 *   is not where the next turn will look. That is answered with `no-workspace` and a reason,
 *   rather than a list of paths the agent will not find.
 *
 * The directory is re-resolved on every call (ownership included), exactly as the rail
 * preview does, and must still sit inside the user's own sandbox once symlinks are resolved.
 */

export const MENTION_RESULT_LIMIT = 20

const FRESH_EACH_TURN =
	'Each turn in this chat starts in a fresh folder, so there are no files to mention. Bind the chat to a project to mention its files.'

export async function searchConversationFiles(input: {
	conversationId: string
	userId: string
	query: string
	limit?: number
}): Promise<MentionSearchResult> {
	const query = input.query.trim()
	if (query.length > MAX_TRIGGER_QUERY || query.includes('\0')) {
		return { ok: false, reason: 'invalid', message: 'That search is not valid.' }
	}

	let workspace
	try {
		workspace = await resolveConversationWorkspace(input.conversationId, input.userId)
	} catch (error) {
		// Someone else's conversation is answered exactly like a missing one.
		if (error instanceof PreviewError) return { ok: false, reason: 'not-found', message: 'Conversation not found.' }
		throw error
	}

	if (!workspaceCarriesOver(workspace.nextTurnKind)) {
		return { ok: false, reason: 'no-workspace', message: FRESH_EACH_TURN }
	}

	try {
		safePathWithin(workspace.containmentRoot, workspace.defaultRoot)
	} catch {
		return { ok: false, reason: 'no-workspace', message: 'This chat’s workspace is not available.' }
	}

	let index
	try {
		index = await getWorkspaceFileIndex(workspace.defaultRoot)
	} catch (error) {
		// A project whose directory has not been created yet has no files, which is not an error.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, results: [], truncated: false }
		throw error
	}

	const results = rankPaths(query, index.entries, input.limit ?? MENTION_RESULT_LIMIT).map((ranked) => ({
		path: ranked.path,
		isDirectory: ranked.isDirectory,
		indices: ranked.indices,
	}))
	return { ok: true, results, truncated: index.truncated }
}
