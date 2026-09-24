import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, seedConversation, uniquePrefix } from './helpers'
import { openAndSend, scriptHeldRun } from './chat-stream-script'
import { parseAskUserAnswerText, readAskUserAnswers } from '../src/lib/chat/ask-user-answers'
import {
	applyAskUser,
	applyAskUserAnswered,
	applyToolResult,
	askUserTokenFor,
	settlePendingAskUser,
	type StreamingBlock,
} from '../src/lib/chat/streaming-blocks'
import { getAskUserAnswersFromTool } from '../src/lib/chat/tool-block-helpers'
import { getAskUserAnswer } from '../src/lib/chat/message-bubble-helpers'
import { askUserAnswerProblem } from '../src/lib/chat/run-controls'

/**
 * #81 — an answered ask_user question never showed as answered.
 *
 * The host gives the model its answers as `Header: answer` lines, and that text is what the
 * call's result carries, live and in the saved transcript. The cards only read a JSON
 * `{ answers }` result. And live, the card is keyed by the host's answer token while the
 * result carries the SDK's tool_use id, so the result never reached the card at all.
 */

const QUESTIONS = [
	{ header: 'Color', question: 'Which color?', options: [{ label: 'green' }, { label: 'blue' }] },
	{ header: 'Color scheme', question: 'Light or dark?', options: [] },
]

test.describe('reading ask_user answers', () => {
	test('the host text reads back per question, multi-line answers included', () => {
		expect(parseAskUserAnswerText('Color: green\nColor scheme: dark\nwith high contrast', ['Color', 'Color scheme'])).toEqual({
			Color: 'green',
			'Color scheme': 'dark\nwith high contrast',
		})
		// Order is the answers', not the questions'.
		expect(parseAskUserAnswerText('Color scheme: light\nColor: blue', ['Color', 'Color scheme'])).toEqual({
			Color: 'blue',
			'Color scheme': 'light',
		})
	})

	test('a result with no answers reads as none', () => {
		expect(parseAskUserAnswerText('The user did not answer in time.', ['Color'])).toBeNull()
		expect(readAskUserAnswers('The user did not answer in time.', ['Color'])).toBeNull()
		expect(readAskUserAnswers(null, ['Color'])).toBeNull()
	})

	test('a JSON answers object still reads, as an object or as its string', () => {
		expect(readAskUserAnswers({ answers: { Color: 'green' } }, ['Color'])).toEqual({ Color: 'green' })
		expect(readAskUserAnswers(JSON.stringify({ answers: { Color: 'green' } }), ['Color'])).toEqual({ Color: 'green' })
	})

	test('the saved transcript finds each answer in the host text', () => {
		const result = 'Color: green\nColor scheme: dark'
		const headers = ['Color', 'Color scheme']
		expect(getAskUserAnswer(result, 'Color', headers)).toBe('green')
		expect(getAskUserAnswer(result, 'Color scheme', headers)).toBe('dark')
		// A single-question call needs no header list.
		expect(getAskUserAnswer('Color: green', 'Color')).toBe('green')
	})
})

test.describe('the live ask_user card', () => {
	const token = 'run-1:q1'
	const opened = (): StreamingBlock[] =>
		applyAskUser([], { id: token, name: 'ask_user', token, questions: QUESTIONS })

	test("the call's result lands on the card, not beside it", () => {
		const outcome = applyToolResult(opened(), {
			id: 'toolu_01ABC',
			name: 'ask_user',
			success: true,
			result: 'Color: green\nColor scheme: dark',
		})
		expect(outcome.missing).toBe(false)
		expect(outcome.unexpectedStatus).toBeNull()
		expect(outcome.blocks).toHaveLength(1)
		const card = outcome.blocks[0]
		expect(card).toMatchObject({ kind: 'tool', id: 'toolu_01ABC', status: 'completed' })
		if (card.kind !== 'tool') throw new Error('expected the ask_user card')
		expect(getAskUserAnswersFromTool(card)).toEqual({ Color: 'green', 'Color scheme': 'dark' })

		// A replayed result (stream resume) finds the card by its new id and adds nothing.
		const replayed = applyToolResult(outcome.blocks, {
			id: 'toolu_01ABC',
			name: 'ask_user',
			success: true,
			result: 'Color: green\nColor scheme: dark',
		})
		expect(replayed.blocks).toHaveLength(1)
	})

	test('an answer the server recorded shows at once, and the result still finds the card', () => {
		const answered = applyAskUserAnswered(opened(), token, { Color: 'blue', 'Color scheme': 'light' })
		const card = answered[0]
		if (card.kind !== 'tool') throw new Error('expected the ask_user card')
		expect(card.status).toBe('completed')
		expect(getAskUserAnswersFromTool(card)).toEqual({ Color: 'blue', 'Color scheme': 'light' })

		const outcome = applyToolResult(answered, {
			id: 'toolu_02DEF',
			name: 'ask_user',
			success: true,
			result: 'Color: blue\nColor scheme: light',
		})
		expect(outcome.blocks).toHaveLength(1)
		expect(outcome.unexpectedStatus).toBeNull()
		expect(outcome.blocks[0]).toMatchObject({ id: 'toolu_02DEF', status: 'completed' })
	})

	test('a second question in the turn gets its own result', () => {
		const first = applyToolResult(opened(), { id: 'toolu_A', name: 'ask_user', success: true, result: 'Color: green' }).blocks
		const withSecond = applyAskUser(first, {
			id: 'run-1:q2',
			name: 'ask_user',
			token: 'run-1:q2',
			questions: [{ header: 'Size', question: 'Which size?', options: [] }],
		})
		const outcome = applyToolResult(withSecond, { id: 'toolu_B', name: 'ask_user', success: true, result: 'Size: large' })
		expect(outcome.blocks.map((b) => b.id)).toEqual(['toolu_A', 'toolu_B'])
	})
})

test.describe('two AskUserQuestion cards open at once (#4)', () => {
	// The CLI runs AskUserQuestion calls concurrently, so one assistant message can open two
	// cards. The page keeps the newest as *the* pending question (the composer and the modal
	// answer it); every card answers under its own token.
	const first = { id: 'toolu_q1', name: 'AskUserQuestion', token: 'run-1:ask:toolu_q1', questions: [{ header: 'Color', question: 'Which color?', options: [{ label: 'green' }, { label: 'blue' }] }] }
	const second = { id: 'toolu_q2', name: 'AskUserQuestion', token: 'run-1:ask:toolu_q2', questions: [{ header: 'Size', question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }] }] }
	const both = (): StreamingBlock[] => applyAskUser(applyAskUser([], first), second)
	const pendingSecond = () => ({ token: second.token, questions: settlePendingAskUser(both(), null, null)!.questions })

	test('the newest open card is the pending one', () => {
		expect(settlePendingAskUser(both(), null, null)).toMatchObject({ token: second.token, questions: [{ question: 'Which size?' }] })
	})

	test('answering the other card leaves the pending question alone', () => {
		const current = pendingSecond()
		const answered = applyAskUserAnswered(both(), first.token, { 'Which color?': 'green' })
		expect(settlePendingAskUser(answered, current, first.token)).toBe(current)
		// …and only that card shows answered.
		expect(answered.map((b) => (b.kind === 'tool' ? b.status : null))).toEqual(['completed', 'executing'])
	})

	test('answering the pending card hands the role to the one still waiting, then to nobody', () => {
		const answered = applyAskUserAnswered(both(), second.token, { 'Which size?': 'L' })
		const next = settlePendingAskUser(answered, pendingSecond(), second.token)
		expect(next).toMatchObject({ token: first.token, questions: [{ question: 'Which color?' }] })
		const done = applyAskUserAnswered(answered, first.token, { 'Which color?': 'blue' })
		expect(settlePendingAskUser(done, next, first.token)).toBeNull()
	})

	test("a call's result settles the card it landed on, found by its tool_use id", () => {
		const outcome = applyToolResult(both(), { id: first.id, name: 'AskUserQuestion', success: false, result: 'The user did not answer.' })
		expect(askUserTokenFor(outcome.blocks, first.id)).toBe(first.token)
		expect(settlePendingAskUser(outcome.blocks, pendingSecond(), askUserTokenFor(outcome.blocks, first.id))?.token).toBe(second.token)
		// Not a question card: no token to settle.
		expect(askUserTokenFor(outcome.blocks, 'toolu_missing')).toBeNull()
	})
})

test('#83 — an ask_user answer counts only when the server recorded it', () => {
	// `/ask-user` answers an unknown token with a 200 and `resolved: false`; the modal used to
	// close as if the answer had been taken.
	expect(askUserAnswerProblem(true, 200, { resolved: true })).toBeNull()
	expect(askUserAnswerProblem(true, 200, { resolved: false })).toMatchObject({ gone: true })
	expect(askUserAnswerProblem(true, 200, null)).toMatchObject({ gone: true })
	expect(askUserAnswerProblem(false, 500, { error: 'boom' })).toMatchObject({ gone: false, message: expect.stringMatching(/status 500/) })
})

test.describe('ask_user on the page', () => {
	const QUESTION = {
		header: 'Color',
		question: 'Which color should the button be?',
		options: [{ label: 'green' }, { label: 'blue' }],
		allowFreeformInput: true,
	}

	test('an answered question shows its answer, not its Submit button (#81)', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-askuser-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: `${runId}:q1`, name: 'ask_user', token: `${runId}:q1`, questions: [QUESTION] } },
			// The engine's result for the same call, under the SDK's own tool_use id, carrying
			// the answer the way the host hands it to the model.
			{ id: 3, event: 'tool_result', data: { id: 'toolu_01live', name: 'ask_user', success: true, result: 'Color: green' } },
		])

		try {
			await openAndSend(page, conversation.id, `${prefix} style it`)
			const main = page.getByRole('main')
			await expect(main.getByText(QUESTION.question).first()).toBeVisible({ timeout: 30_000 })
			await expect(main.locator('.user-bubble', { hasText: 'green' }).first()).toBeVisible()
			await expect(main.getByRole('button', { name: 'Submit' })).toHaveCount(0)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an answer that went nowhere says so (#83)', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-askuser-gone')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: `${runId}:q1`, name: 'ask_user', token: `${runId}:q1`, questions: [QUESTION] } },
		])
		const answers: unknown[] = []
		await page.route(
			(url) => url.pathname === `/chat/${conversation.id}/ask-user`,
			(route) => {
				answers.push(route.request().postDataJSON())
				return route.fulfill({ json: { resolved: false } })
			},
		)

		try {
			await openAndSend(page, conversation.id, `${prefix} style it`)
			const main = page.getByRole('main')
			await expect(main.getByText(QUESTION.question).first()).toBeVisible({ timeout: 30_000 })
			await main.getByRole('button', { name: 'green' }).first().click()
			await main.getByRole('button', { name: 'Submit' }).first().click()

			await expect.poll(() => answers.length).toBe(1)
			await expect(page.getByText(/no longer waiting for an answer/).first()).toBeVisible()
			await expect(main.locator('.user-bubble', { hasText: 'green' })).toHaveCount(0)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a saved answer shows after a reload, in the text the host recorded (#81)', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-askuser-saved')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const blocks = [
			{
				kind: 'tool',
				name: 'ask_user',
				arguments: { questions: [QUESTION, { header: 'Size', question: 'How large?', options: [] }] },
				result: 'Color: green\nSize: large,\nbut not huge',
				success: true,
				executionMs: 0,
			},
			{ kind: 'text', content: `${prefix} styled it` },
		]
		const sql = getSql()
		await sql`
			insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
			values (${conversation.id}, 'assistant', ${`${prefix} styled it`}, ${sql.json({ blocks })}, '[]'::jsonb, 3)
		`

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
			const main = page.getByRole('main')
			await expect(main.getByText(`${prefix} styled it`).first()).toBeVisible({ timeout: 30_000 })
			await expect(main.locator('.user-bubble', { hasText: /^green$/ }).first()).toBeVisible()
			await expect(main.locator('.user-bubble', { hasText: 'large,' }).first()).toContainText('but not huge')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
