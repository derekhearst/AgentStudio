import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * A paused run's approval and question items close when the prompt is settled, and
 * answering one from /review answers the run.
 *
 * They were opened for every approval and every ask_user question and never closed:
 * approving in the chat left the item open for good, and the open-inbox count only grew.
 * The inbox's Resolve and Dismiss changed the review row and nothing else, so approving from
 * /review while away from the chat left the tool call waiting until it timed out, denied.
 */

type ItemRow = {
	status: string
	resolution: { action: string; note?: string } | null
	resolved_by: string | null
}

async function seedPausedRun(prefix: string, kind: 'approval' | 'question') {
	const sql = getSql()
	const userId = await getActiveUserId()
	const token = `${prefix}:${kind}`
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'claude-sonnet-5', 0, '0')
		returning id
	`
	const approvals = kind === 'approval' ? [{ token, toolName: 'Bash', args: { command: 'ls' }, requestedAt: new Date().toISOString() }] : []
	const questions =
		kind === 'question'
			? [
					{
						token,
						questions: [{ header: 'Scope', question: 'Which folder?', options: [{ label: 'src' }], allowFreeformInput: true }],
						requestedAt: new Date().toISOString(),
					},
				]
			: []
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, pending_approvals, pending_questions)
		values (
			${conv.id}, ${userId},
			${kind === 'approval' ? 'waiting_tool_approval' : 'waiting_user_input'}::chat_run_state,
			${sql.json(approvals)}, ${sql.json(questions)}
		)
		returning id
	`
	const { openReviewItem } = await import('../src/lib/observability/review.server')
	const item = await openReviewItem({
		type: kind === 'approval' ? 'approval_request' : 'user_question',
		summary: `${prefix} ${kind}`,
		payload: kind === 'approval' ? { toolName: 'Bash', token } : { token, questions: questions[0].questions },
		runId: run.id,
		dedupeKey: `${kind}:${token}`,
	})
	return { runId: run.id, token, itemId: item!.id, userId }
}

async function readItem(itemId: string): Promise<ItemRow> {
	const sql = getSql()
	const [row] = await sql<ItemRow[]>`select status::text as status, resolution, resolved_by from review_items where id = ${itemId}`
	return row
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`${prefix}%`}`
	await sql`delete from conversations where title like ${`${prefix}%`}`
}

test.describe('review/prompt-items — items close when the prompt is settled', () => {
	test('an approval answered in the chat closes its item, as resolved by that user', async () => {
		const prefix = uniquePrefix('prompt-approved-in-chat')
		try {
			const { runId, token, itemId, userId } = await seedPausedRun(prefix, 'approval')
			const { recordApprovalDecision } = await import('../src/lib/runs/approvals.server')
			await recordApprovalDecision(runId, token, true, { decidedBy: userId, note: 'Answered in the chat' })

			const item = await readItem(itemId)
			expect(item.status).toBe('resolved')
			expect(item.resolution?.action).toBe('approved')
			expect(item.resolved_by).toBe(userId)
		} finally {
			await cleanup(prefix)
		}
	})

	test('an approval nobody answers closes as dismissed when the run gives up', async () => {
		const prefix = uniquePrefix('prompt-timed-out')
		try {
			const { runId, token, itemId } = await seedPausedRun(prefix, 'approval')
			const { awaitApprovalDecision } = await import('../src/lib/runs/approvals.server')
			expect(await awaitApprovalDecision(runId, token, 10)).toBe(false)

			const item = await readItem(itemId)
			expect(item.status).toBe('dismissed')
			expect(item.resolution?.action).toBe('timed_out')
		} finally {
			await cleanup(prefix)
		}
	})

	test('an answered question closes its item', async () => {
		const prefix = uniquePrefix('prompt-answered')
		try {
			const { runId, token, itemId } = await seedPausedRun(prefix, 'question')
			const { recordQuestionAnswers } = await import('../src/lib/runs/questions.server')
			await recordQuestionAnswers(runId, token, { Scope: 'src' })

			const item = await readItem(itemId)
			expect(item.status).toBe('resolved')
			expect(item.resolution?.action).toBe('answered')
		} finally {
			await cleanup(prefix)
		}
	})

	test('the sweep closes items whose run ended, and leaves the ones still waiting', async () => {
		const prefix = uniquePrefix('prompt-sweep')
		const sql = getSql()
		try {
			const ended = await seedPausedRun(`${prefix}-ended`, 'approval')
			const waiting = await seedPausedRun(`${prefix}-waiting`, 'question')
			// What the reaper leaves behind: the run canceled, its prompts cleared, the item open.
			await sql`
				update chat_runs set state = 'canceled'::chat_run_state, finished_at = now(), pending_approvals = '[]'::jsonb
				where id = ${ended.runId}
			`
			const { closeStalePromptReviewItems } = await import('../src/lib/runs/prompt-review-items.server')
			// Scoped to this spec's runs: the database is shared.
			await closeStalePromptReviewItems({ runIds: [ended.runId, waiting.runId] })

			const closed = await readItem(ended.itemId)
			expect(closed.status).toBe('dismissed')
			expect(closed.resolution?.action).toBe('expired')
			expect((await readItem(waiting.itemId)).status).toBe('open')
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('review/prompt-items — answering from /review answers the run', () => {
	test('Approve from the inbox records the decision on the run the call is waiting on', async () => {
		const prefix = uniquePrefix('prompt-review-approve')
		const sql = getSql()
		try {
			const { runId, itemId, userId } = await seedPausedRun(prefix, 'approval')
			const { decideApprovalFromReview } = await import('../src/lib/runs/review-decisions.server')

			expect(await decideApprovalFromReview({ itemId, userId, approved: true })).toEqual({ resolved: true })

			const [run] = await sql<{ pending_approvals: Array<{ decision?: string }> }[]>`
				select pending_approvals from chat_runs where id = ${runId}
			`
			expect(run.pending_approvals[0].decision).toBe('approved')
			const item = await readItem(itemId)
			expect(item.status).toBe('resolved')
			expect(item.resolution?.action).toBe('approved')
			expect(item.resolved_by).toBe(userId)
		} finally {
			await cleanup(prefix)
		}
	})

	test('an answer to a run that stopped waiting is refused, and the item closes', async () => {
		const prefix = uniquePrefix('prompt-review-expired')
		const sql = getSql()
		try {
			const { runId, itemId, userId } = await seedPausedRun(prefix, 'approval')
			await sql`update chat_runs set pending_approvals = '[]'::jsonb where id = ${runId}`
			const { decideApprovalFromReview } = await import('../src/lib/runs/review-decisions.server')

			expect(await decideApprovalFromReview({ itemId, userId, approved: true })).toEqual({
				resolved: false,
				reason: 'no_longer_waiting',
			})
			const item = await readItem(itemId)
			expect(item.status).toBe('dismissed')
			expect(item.resolution?.action).toBe('expired')
		} finally {
			await cleanup(prefix)
		}
	})

	test('answering a question from the inbox hands the run the answers', async () => {
		const prefix = uniquePrefix('prompt-review-answer')
		const sql = getSql()
		try {
			const { runId, itemId, userId } = await seedPausedRun(prefix, 'question')
			const { answerQuestionFromReview } = await import('../src/lib/runs/review-decisions.server')

			expect(await answerQuestionFromReview({ itemId, userId, answers: { Scope: 'src' } })).toEqual({ resolved: true })

			const [run] = await sql<{ pending_questions: Array<{ answers?: Record<string, string> }> }[]>`
				select pending_questions from chat_runs where id = ${runId}
			`
			expect(run.pending_questions[0].answers).toEqual({ Scope: 'src' })
			expect((await readItem(itemId)).resolution?.action).toBe('answered')
		} finally {
			await cleanup(prefix)
		}
	})

	test('an approval decision cannot be applied to a different kind of item', async () => {
		const prefix = uniquePrefix('prompt-review-wrong-type')
		try {
			const { itemId, userId } = await seedPausedRun(prefix, 'question')
			const { decideApprovalFromReview } = await import('../src/lib/runs/review-decisions.server')
			expect(await decideApprovalFromReview({ itemId, userId, approved: true })).toEqual({
				resolved: false,
				reason: 'wrong_type',
			})
			expect((await readItem(itemId)).status).toBe('open')
		} finally {
			await cleanup(prefix)
		}
	})
})
