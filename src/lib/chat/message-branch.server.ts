/**
 * Edit and regenerate: cutting a conversation back to one of its user messages.
 *
 * Both change `messages` only, and mark the row they cut back to (`SDK_CUT_PENDING_KEY`).
 * The next turn cuts the SDK session to match (`./turn-plan`) — the regenerate that follows,
 * or, if that never starts, whatever message the user sends next. With `restoreFiles`, the
 * files the dropped turns changed are restored first (#24), and a restore that fails leaves
 * the conversation exactly as it was — the user can then choose to go on without it.
 *
 * Refused while a turn is running: the turn would save its reply under a message that no
 * longer says what it answered, and its session would be cut out from under it.
 */

import { and, eq, gt } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { findLiveChatRun } from '$lib/runs/live-chat-run.server'
import { applyMessageRewind, isConversationRewinding, type RewindDeps } from './rewind.server'
import { markCutPending } from './turn-plan.server'

export type BranchInput = {
	userId: string
	/** The user message the conversation is cut back to. */
	messageId: string
	/** Also restore the files the dropped turns changed. */
	restoreFiles?: boolean
	/** The user confirmed that uncommitted changes in an imported repository may be overwritten. */
	acknowledgeUncommitted?: boolean
}

export type BranchResult =
	| {
			success: true
			conversationId: string
			/** Files put back as they were. */
			filesRestored: number
			/** Files the restore left alone because a link was in the way (`RewindFilesResult.skippedLinks`). */
			skippedLinks: number
	  }
	| { success: false; error: string; rewindFailed?: true }

type Restored = { filesRestored: number; skippedLinks: number }
const NOTHING_RESTORED: Restored = { filesRestored: 0, skippedLinks: 0 }

const NOT_FOUND = 'Message not found or not editable'
const TURN_RUNNING = 'A reply is still being written. Wait for it to finish, or stop it, first.'

/** The caller's own user message, with the conversation it belongs to. */
async function loadOwnUserMessage(userId: string, messageId: string, conversationId?: string) {
	const [row] = await db
		.select({ id: messages.id, role: messages.role, sequence: messages.sequence, conversationId: messages.conversationId })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(messages.id, messageId),
				eq(conversations.userId, userId),
				...(conversationId ? [eq(messages.conversationId, conversationId)] : []),
			),
		)
		.limit(1)
	return row && row.role === 'user' ? row : null
}

/** Refuse while a turn or a rewind is running, then restore the files when asked. */
async function prepareBranch(
	input: BranchInput,
	conversationId: string,
	deps: RewindDeps,
): Promise<{ error: BranchResult } | Restored> {
	if (await findLiveChatRun(conversationId, input.userId)) return { error: { success: false, error: TURN_RUNNING } }
	if (isConversationRewinding(conversationId)) {
		return { error: { success: false, error: 'Files are already being restored in this conversation.' } }
	}
	if (!input.restoreFiles) return NOTHING_RESTORED
	const rewind = await applyMessageRewind(
		{ userId: input.userId, messageId: input.messageId, acknowledgeUncommitted: input.acknowledgeUncommitted },
		deps,
	)
	if (!rewind.ok) {
		return {
			error: {
				success: false,
				error: `${rewind.error} The conversation was not changed: try again, or go on without restoring the files.`,
				rewindFailed: true,
			},
		}
	}
	return { filesRestored: rewind.filesRestored, skippedLinks: rewind.skippedLinks }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Every row after `sequence` — the turns the cut drops. Sequence, not time: two rows can share a millisecond. */
async function deleteAfter(tx: Tx, conversationId: string, sequence: number) {
	await tx.delete(messages).where(and(eq(messages.conversationId, conversationId), gt(messages.sequence, sequence)))
}

/** Replace a user message's text and drop everything after it. */
export async function editUserMessage(
	input: BranchInput & { content: string },
	deps: RewindDeps = {},
): Promise<BranchResult> {
	const target = await loadOwnUserMessage(input.userId, input.messageId)
	if (!target) return { success: false, error: NOT_FOUND }

	const prepared = await prepareBranch(input, target.conversationId, deps)
	if ('error' in prepared) return prepared.error

	await db.transaction(async (tx) => {
		await tx.update(messages).set({ content: input.content, metadata: markCutPending() }).where(eq(messages.id, target.id))
		await deleteAfter(tx, target.conversationId, target.sequence)
	})
	return { success: true, conversationId: target.conversationId, ...prepared }
}

/** Drop everything after a user message, so its reply can be written again. */
export async function truncateAfterMessage(
	input: BranchInput & { conversationId: string },
	deps: RewindDeps = {},
): Promise<BranchResult> {
	const target = await loadOwnUserMessage(input.userId, input.messageId, input.conversationId)
	if (!target) return { success: false, error: 'Message not found' }

	const prepared = await prepareBranch(input, target.conversationId, deps)
	if ('error' in prepared) return prepared.error

	await db.transaction(async (tx) => {
		await tx.update(messages).set({ metadata: markCutPending() }).where(eq(messages.id, target.id))
		await deleteAfter(tx, target.conversationId, target.sequence)
	})
	return { success: true, conversationId: target.conversationId, ...prepared }
}
