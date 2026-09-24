import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { recordApprovalDecision } from './approvals.server'
import { recordQuestionAnswers } from './questions.server'
import { closePromptReviewItem, PROMPT_REVIEW_TYPE, type PromptKind } from './prompt-review-items.server'

/**
 * Answering a paused run from /review.
 *
 * The inbox showed approval requests and agent questions with Resolve and Dismiss buttons
 * that only changed the review row. The run never heard: approving from /review while away
 * from the chat left the call waiting until it timed out and was denied. These answer the
 * run itself, exactly as the chat's cards do, and the item closes as a result.
 */

export type ReviewDecisionResult =
	| { resolved: true }
	| {
			resolved: false
			reason: 'not_found' | 'wrong_type' | 'already_closed' | 'not_yours' | 'no_longer_waiting'
	  }

type OpenPrompt = { token: string; runId: string }

async function loadOpenPrompt(
	itemId: string,
	userId: string,
	kind: PromptKind,
): Promise<OpenPrompt | Exclude<ReviewDecisionResult, { resolved: true }>> {
	const { getReviewItemById } = await import('$lib/observability/review.server')
	const item = await getReviewItemById(itemId)
	if (!item) return { resolved: false, reason: 'not_found' }
	if (item.type !== PROMPT_REVIEW_TYPE[kind]) return { resolved: false, reason: 'wrong_type' }
	if (item.status !== 'open' && item.status !== 'in_progress') return { resolved: false, reason: 'already_closed' }

	const token = typeof item.payload.token === 'string' ? item.payload.token : null
	const [run] = item.runId
		? await db.select({ userId: chatRuns.userId }).from(chatRuns).where(eq(chatRuns.id, item.runId)).limit(1)
		: []
	if (!run || !token || !item.runId) {
		if (token) await closePromptReviewItem(kind, token, { action: 'expired' })
		return { resolved: false, reason: 'no_longer_waiting' }
	}
	if (run.userId && run.userId !== userId) return { resolved: false, reason: 'not_yours' }
	return { token, runId: item.runId }
}

/**
 * Approve or deny the tool call behind an `approval_request` item. A run that has stopped
 * waiting — timed out, ended, reaped — cannot take the answer; its item closes as expired
 * and the caller is told so rather than shown a success.
 */
export async function decideApprovalFromReview(input: {
	itemId: string
	userId: string
	approved: boolean
	note?: string
}): Promise<ReviewDecisionResult> {
	const prompt = await loadOpenPrompt(input.itemId, input.userId, 'approval')
	if ('resolved' in prompt) return prompt
	const result = await recordApprovalDecision(prompt.runId, prompt.token, input.approved, {
		decidedBy: input.userId,
		note: input.note ?? (input.approved ? 'Approved from the review inbox' : 'Denied from the review inbox'),
	})
	if (result.resolved) return { resolved: true }
	await closePromptReviewItem('approval', prompt.token, { action: 'expired' })
	return { resolved: false, reason: 'no_longer_waiting' }
}

/** Answer the questions behind a `user_question` item, keyed by question header as the chat does. */
export async function answerQuestionFromReview(input: {
	itemId: string
	userId: string
	answers: Record<string, string>
}): Promise<ReviewDecisionResult> {
	const prompt = await loadOpenPrompt(input.itemId, input.userId, 'question')
	if ('resolved' in prompt) return prompt
	const result = await recordQuestionAnswers(prompt.runId, prompt.token, input.answers, {
		decidedBy: input.userId,
		note: 'Answered from the review inbox',
	})
	if (result.resolved) return { resolved: true }
	await closePromptReviewItem('question', prompt.token, { action: 'expired' })
	return { resolved: false, reason: 'no_longer_waiting' }
}
