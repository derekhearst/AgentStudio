/**
 * The database half of `./turn-plan`: what a turn sends and how it starts its session,
 * and the join it leaves behind on the user row.
 */

import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { messages } from '$lib/sessions/sessions.schema'
import { logger } from '$lib/observability/logger'
import type { ChatAttachment } from '$lib/engine/attachments.server'
import type { TurnAttemptPlan } from '$lib/engine/turn-input'
import { readTailUuid, resolveTurnResume, SDK_TURN_KEY, type TurnJoin } from './turn-plan'

/** How much kept history a fallback preamble may draw on. `buildHistoryPreamble` trims further. */
const KEPT_HISTORY_ROWS = 200

export type PlannedTurn = {
	/** The text of the turn: the new message, or the edited / regenerated row's own content. */
	text: string
	/** Its attachments, from the request or from the row. */
	attachments: ChatAttachment[]
	attempts: TurnAttemptPlan
}

/**
 * Plan one turn.
 *
 * A regenerate never trusts the request body. The client used to send the placeholder
 * `'regenerate'` as the content, and the server used it as the prompt; the prompt is now
 * the pivot row's own text and attachments — after an edit, the edited text.
 */
export async function planTurn(input: {
	conversationId: string
	regenerate: boolean
	sdkSessionId: string | null
	/** For a regenerate, the user row being answered again (`resolveParentMessage`'s answer). */
	pivotMessageId: string | null
	body: { content?: string; attachments?: ChatAttachment[] }
}): Promise<{ ok: true; turn: PlannedTurn } | { ok: false; error: string }> {
	if (!input.regenerate) {
		return {
			ok: true,
			turn: {
				text: input.body.content ?? '',
				attachments: input.body.attachments ?? [],
				attempts: resolveTurnResume({
					regenerate: false,
					sdkSessionId: input.sdkSessionId,
					previousAssistant: null,
					keptHistory: [],
					mintUuid: randomUUID,
				}),
			},
		}
	}

	if (!input.pivotMessageId) return { ok: false, error: 'There is no message to regenerate a reply to.' }
	const [pivot] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.id, input.pivotMessageId), eq(messages.conversationId, input.conversationId)))
		.limit(1)
	if (!pivot || pivot.role !== 'user') return { ok: false, error: 'There is no message to regenerate a reply to.' }

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

	const assistantMeta = previousAssistant?.metadata as Record<string, unknown> | undefined
	return {
		ok: true,
		turn: {
			text: pivot.content,
			attachments: pivot.attachments ?? [],
			attempts: resolveTurnResume({
				regenerate: true,
				sdkSessionId: input.sdkSessionId,
				previousAssistant: previousAssistant
					? {
							sdkSessionId: typeof assistantMeta?.sdkSessionId === 'string' ? assistantMeta.sdkSessionId : null,
							sdkTailUuid: readTailUuid(assistantMeta),
						}
					: null,
				keptHistory: kept,
				mintUuid: randomUUID,
			}),
		},
	}
}

/**
 * Stamp the user row with where its prompt landed in the transcript. Merged into the
 * metadata rather than replacing it; a regenerate overwrites the old join, whose uuid now
 * sits on a branch the session no longer follows.
 */
export async function recordTurnJoin(userMessageId: string, join: TurnJoin): Promise<void> {
	await db
		.update(messages)
		.set({ metadata: sql`${messages.metadata} || ${JSON.stringify({ [SDK_TURN_KEY]: join })}::jsonb` })
		.where(and(eq(messages.id, userMessageId), eq(messages.role, 'user')))
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

