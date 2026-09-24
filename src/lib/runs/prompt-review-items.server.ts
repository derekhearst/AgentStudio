import { and, eq, inArray } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { reviewItems } from '$lib/observability/observability.schema'
import { logger } from '$lib/observability/logger'

/**
 * The review-inbox items a paused run opens — one per tool approval, one per question the
 * agent asks (AskUserQuestion, #4) — and how they close.
 *
 * They used to be opened and never closed. Approving a call in the chat left its item open
 * in /review for good, each approval added another, and the inbox's open count and the
 * `review_inbox.open` metric only ever went up. Now an item closes when its prompt is
 * settled, whichever way:
 *
 *   approved / denied / answered   someone answered, in the chat or in /review
 *   timed_out                      the run gave up waiting (`DECISION_TIMEOUT_MS`)
 *   expired                        the run ended, or the prompt is gone, while it was open
 *
 * The first three close it as `resolved`; the last two as `dismissed`, since nobody acted.
 * `expired` is the sweep's, for items whose closing write never happened — a process that
 * restarted mid-wait, a run that was reaped.
 */

export type PromptKind = 'approval' | 'question'

export const PROMPT_REVIEW_TYPE = {
	approval: 'approval_request',
	question: 'user_question',
} as const

/** The dedupe key the item is opened under, and found by again when it closes. */
export function promptDedupeKey(kind: PromptKind, token: string): string {
	return `${kind}:${token}`
}

export type PromptClosure =
	| { action: 'approved' | 'denied' | 'answered'; decidedBy?: string | null; note?: string }
	| { action: 'timed_out' | 'expired'; note?: string }

const DEFAULT_NOTES: Record<PromptClosure['action'], string> = {
	approved: 'Approved',
	denied: 'Denied',
	answered: 'Answered',
	timed_out: 'Nobody answered in time; the run went on without it',
	expired: 'The run is no longer waiting for this',
}

export async function closePromptReviewItem(kind: PromptKind, token: string, closure: PromptClosure): Promise<void> {
	try {
		const { resolveReviewItemsByDedupeKey } = await import('$lib/observability/review.server')
		const nobodyActed = closure.action === 'timed_out' || closure.action === 'expired'
		await resolveReviewItemsByDedupeKey({
			type: PROMPT_REVIEW_TYPE[kind],
			dedupeKey: promptDedupeKey(kind, token),
			action: closure.action,
			note: closure.note ?? DEFAULT_NOTES[closure.action],
			resolvedBy: 'decidedBy' in closure ? (closure.decidedBy ?? null) : null,
			finalStatus: nobodyActed ? 'dismissed' : 'resolved',
		})
	} catch (err) {
		logger.warn('[runs] closing a prompt review item failed (non-fatal)', { err, kind })
	}
}

/**
 * Close every open approval or question item whose prompt can no longer be answered: its run
 * is gone or ended, or the prompt is no longer pending on it. Returns how many it closed.
 * Runs from the `runs_reap` tick; `runIds` narrows it to some runs' items.
 */
export async function closeStalePromptReviewItems(scope: { runIds?: string[] } = {}): Promise<number> {
	if (scope.runIds && scope.runIds.length === 0) return 0
	const open = await db
		.select({
			id: reviewItems.id,
			type: reviewItems.type,
			payload: reviewItems.payload,
			runId: reviewItems.runId,
		})
		.from(reviewItems)
		.where(
			and(
				inArray(reviewItems.type, [PROMPT_REVIEW_TYPE.approval, PROMPT_REVIEW_TYPE.question]),
				inArray(reviewItems.status, ['open', 'in_progress']),
				scope.runIds ? inArray(reviewItems.runId, scope.runIds) : undefined,
			),
		)
		.limit(500)

	let closed = 0
	for (const item of open) {
		const token = typeof item.payload.token === 'string' ? item.payload.token : null
		const kind: PromptKind = item.type === PROMPT_REVIEW_TYPE.approval ? 'approval' : 'question'
		const [run] = item.runId
			? await db
					.select({
						finishedAt: chatRuns.finishedAt,
						pendingApprovals: chatRuns.pendingApprovals,
						pendingQuestions: chatRuns.pendingQuestions,
					})
					.from(chatRuns)
					.where(eq(chatRuns.id, item.runId))
					.limit(1)
			: []
		const stillWaiting =
			!!run &&
			!run.finishedAt &&
			token !== null &&
			(kind === 'approval'
				? (run.pendingApprovals ?? []).some((e) => e.token === token && !e.decision)
				: (run.pendingQuestions ?? []).some((e) => e.token === token && !e.answers))
		if (stillWaiting) continue

		const now = new Date()
		const updated = await db
			.update(reviewItems)
			.set({
				status: 'dismissed',
				resolution: { action: 'expired', note: DEFAULT_NOTES.expired },
				resolvedAt: now,
				updatedAt: now,
			})
			.where(and(eq(reviewItems.id, item.id), inArray(reviewItems.status, ['open', 'in_progress'])))
			.returning({ id: reviewItems.id })
		closed += updated.length
	}
	return closed
}
