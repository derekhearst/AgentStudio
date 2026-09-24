/**
 * The database half of `./turn-plan`: what a turn sends and how it starts its session,
 * and the join it leaves behind on the user row.
 */

import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { messages } from '$lib/sessions/sessions.schema'
import { logger } from '$lib/observability/logger'
import type { ChatAttachment } from '$lib/engine/attachments.server'
import type { TurnAttemptPlan } from '$lib/engine/turn-input'
import {
	isSlashCommand,
	readTailUuid,
	resolveTurnResume,
	SDK_CUT_PENDING_KEY,
	SDK_TURN_KEY,
	unansweredTail,
	type TurnJoin,
} from './turn-plan'

/** How much kept history a fallback preamble may draw on. `buildHistoryPreamble` trims further. */
const KEPT_HISTORY_ROWS = 200

export type PlannedTurn = {
	/** The text of the turn: the new message, or the edited / regenerated row's own content. */
	text: string
	/** Its attachments, from the request or from the row. */
	attachments: ChatAttachment[]
	attempts: TurnAttemptPlan
}

/** Whether an edit or regenerate cut this conversation's rows back and no turn has cut the session to match. */
const cutPending = sql`(${messages.metadata} ->> ${SDK_CUT_PENDING_KEY}::text) = 'true'`

async function conversationHasPendingCut(conversationId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user'), cutPending))
		.limit(1)
	return Boolean(row)
}

/**
 * Plan one turn.
 *
 * A regenerate never trusts the request body. The client used to send the placeholder
 * `'regenerate'` as the content, and the server used it as the prompt; the prompt is now
 * the pivot row's own text and attachments — after an edit, the edited text.
 *
 * A regenerate always cuts the session back to the kept history. So does an ordinary new
 * message while an edit or regenerate's cut is still pending (`SDK_CUT_PENDING_KEY`): its
 * reply never started — the request failed, or the server restarted — and the session
 * still holds the turns the page no longer shows.
 */
export async function planTurn(input: {
	conversationId: string
	regenerate: boolean
	sdkSessionId: string | null
	/**
	 * The user row this turn answers (`resolveParentMessage`'s answer): for a regenerate the
	 * row being answered again, otherwise the one just inserted for the new message.
	 */
	pivotMessageId: string | null
	body: { content?: string; attachments?: ChatAttachment[] }
}): Promise<{ ok: true; turn: PlannedTurn } | { ok: false; error: string }> {
	const cut = input.regenerate || (input.pivotMessageId !== null && (await conversationHasPendingCut(input.conversationId)))
	if (!cut) {
		return {
			ok: true,
			turn: {
				text: input.body.content ?? '',
				attachments: input.body.attachments ?? [],
				attempts: resolveTurnResume({
					cut: false,
					sdkSessionId: input.sdkSessionId,
					previousAssistant: null,
					keptHistory: [],
					mintUuid: randomUUID,
				}),
			},
		}
	}

	const noPivot = input.regenerate ? 'There is no message to regenerate a reply to.' : 'The message to answer was not found.'
	if (!input.pivotMessageId) return { ok: false, error: noPivot }
	const [pivot] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, input.pivotMessageId), eq(messages.conversationId, input.conversationId)))
		.limit(1)
	if (!pivot || pivot.role !== 'user') return { ok: false, error: noPivot }

	const [previousAssistant] = await db
		.select({ metadata: messages.metadata })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, input.conversationId),
				eq(messages.role, 'assistant'),
				lt(messages.sequence, pivot.sequence),
			),
		)
		.orderBy(desc(messages.sequence))
		.limit(1)

	const kept = await db
		.select({ role: messages.role, content: messages.content })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, input.conversationId),
				inArray(messages.role, ['user', 'assistant']),
				lt(messages.sequence, pivot.sequence),
			),
		)
		.orderBy(desc(messages.sequence))
		.limit(KEPT_HISTORY_ROWS)
	kept.reverse()

	// A new message sends what the request says, as it always has; a regenerate, the row's own.
	const text = input.regenerate ? pivot.content : (input.body.content ?? '')
	const attachments = input.regenerate ? (pivot.attachments ?? []) : (input.body.attachments ?? [])
	const assistantMeta = previousAssistant?.metadata as Record<string, unknown> | undefined
	return {
		ok: true,
		turn: {
			text,
			attachments,
			attempts: resolveTurnResume({
				cut: true,
				sdkSessionId: input.sdkSessionId,
				previousAssistant: previousAssistant
					? {
							sdkSessionId: typeof assistantMeta?.sdkSessionId === 'string' ? assistantMeta.sdkSessionId : null,
							sdkTailUuid: readTailUuid(assistantMeta),
						}
					: null,
				keptHistory: kept,
				// Nothing may go in front of a slash command; those rows stay on the page only.
				unanswered: isSlashCommand(text) ? [] : unansweredTail(kept),
				mintUuid: randomUUID,
			}),
		},
	}
}

/**
 * Stamp the user row with where its prompt landed in the transcript. Merged into the
 * metadata rather than replacing it; a regenerate overwrites the old join, whose uuid now
 * sits on a branch the session no longer follows.
 *
 * Also clears any pending cut up to that row: the turn's session now starts from the cut,
 * or afresh, so the next message can resume it as it is.
 */
export async function recordTurnJoin(userMessageId: string, join: TurnJoin): Promise<void> {
	const [row] = await db
		.update(messages)
		.set({ metadata: sql`${messages.metadata} || ${JSON.stringify({ [SDK_TURN_KEY]: join })}::jsonb` })
		.where(and(eq(messages.id, userMessageId), eq(messages.role, 'user')))
		.returning({ conversationId: messages.conversationId, sequence: messages.sequence })
	if (!row) return
	await db
		.update(messages)
		.set({ metadata: sql`${messages.metadata} - ${SDK_CUT_PENDING_KEY}::text` })
		.where(
			and(
				eq(messages.conversationId, row.conversationId),
				eq(messages.role, 'user'),
				lte(messages.sequence, row.sequence),
				cutPending,
			),
		)
}

/**
 * Mark the user row an edit or regenerate cut the conversation back to. Written with the
 * cut itself (`./message-branch.server`), in the same transaction.
 */
export function markCutPending() {
	return sql`${messages.metadata} || ${JSON.stringify({ [SDK_CUT_PENDING_KEY]: true })}::jsonb`
}

/** Fire-and-forget `recordTurnJoin`, for the stream's `onSessionId`. A failed write must not fail a turn. */
export function recordTurnJoinInBackground(userMessageId: string | null, join: TurnJoin): void {
	if (!userMessageId) return
	void recordTurnJoin(userMessageId, join).catch((error) =>
		logger.warn('[chat/stream] failed to record the transcript join', {
			messageId: userMessageId,
			error: String(error),
		}),
	)
}

