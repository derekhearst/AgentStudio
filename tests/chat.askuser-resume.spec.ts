import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Cold-load resume of a paused ask_user. Closes the gap where a hard refresh during an
 * active ask_user pause used to drop the pending question (pendingAskUser is only set
 * by SSE events; nothing rebuilt it from chat_runs.pending_questions on cold load).
 *
 * Flow:
 *   1. Seed a conversation + chat_run (state='waiting_user_input') + un-decided pending_questions
 *   2. Navigate to /chat/[id]
 *   3. RunHud's "Answer" button appears (visible only when pendingAskUser is non-null)
 *   4. Click Answer → modal opens with the seeded question
 *   5. Click an option → option highlights + Submit becomes enabled
 *   6. Click Submit → POST /chat/[id]/ask-user fires + chat_runs.pending_questions records the answer
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function seedPausedAskUser(prefix: string) {
	const sql = getSql()
	const userId = await getActiveUserId()

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} resume`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`

	const token = randomUUID()
	const questions = [
		{
			header: 'Color',
			question: 'What is your favorite color',
			options: [
				{ label: 'green', description: 'A calming color' },
				{ label: 'blue', description: 'A serene color' },
			],
			allowFreeformInput: false,
		},
	]

	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label, pending_questions)
		values (
			${conversation.id},
			${userId},
			'waiting_user_input',
			'chat_stream',
			${`${prefix} run`},
			${sql.json([{ token, questions, requestedAt: new Date().toISOString() }])}
		)
		returning id
	`

	// User prompt + assistant message carrying the (executing) ask_user tool block.
	const [userMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (${conversation.id}, 'user', 'Pick a color', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb)
		returning id
	`

	const blocks = [
		{
			kind: 'tool',
			name: 'ask_user',
			arguments: { questions },
			executionMs: 0,
		},
	]

	await sql`
		insert into messages (conversation_id, role, content, model, parent_message_id, metadata, tool_calls)
		values (
			${conversation.id},
			'assistant',
			${'Asking…'},
			${'anthropic/claude-sonnet-4'},
			${userMsg.id},
			${sql.json({ blocks })},
			${sql.json([{ name: 'ask_user', arguments: { questions }, executionMs: 0 }])}
		)
	`

	return { userId, conversationId: conversation.id, runId: run.id, token }
}

test.describe('chat/ask-user — cold-load resume after hard refresh', () => {
	test('a paused ask_user with pending_questions can be answered after a hard refresh', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-askuser-resume')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const seeded = await seedPausedAskUser(prefix)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${seeded.conversationId}`, { waitUntil: 'domcontentloaded' })

			// The seeded user prompt confirms the page rendered the conversation.
			await page.getByText('Pick a color', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })

			// RunHud "Answer" button is the only path to the modal on cold load — its presence
			// proves pendingAskUser was reconstructed from chat_runs.pending_questions.
			const answerButton = page.getByRole('button', { name: /^Answer$/i }).first()
			await expect(answerButton).toBeVisible({ timeout: 10_000 })
			await answerButton.click()

			// Modal opens with the seeded question.
			await expect(page.getByText('What is your favorite color', { exact: false }).first()).toBeVisible({
				timeout: 10_000,
			})

			// Click the "green" option button (rendered by AskUserQuestionCard). The accessible
			// name combines label + description ("green A calming color") since both render
			// inside the same <button>.
			const greenOption = page.getByRole('button', { name: /^green\b/ }).first()
			await greenOption.click()

			// Submit is enabled now (no missing answers). Click it.
			const submitButton = page.getByRole('button', { name: /^Submit$/i }).first()
			await expect(submitButton).toBeEnabled({ timeout: 5_000 })

			const askUserResp = page.waitForResponse(
				(r) => r.url().includes(`/chat/${seeded.conversationId}/ask-user`) && r.status() === 200,
				{ timeout: 15_000 },
			)
			await submitButton.click()
			const resp = await askUserResp
			const body = await resp.json()
			expect(body.resolved).toBe(true)

			// chat_runs.pending_questions[0].answers carries the picked option, decidedAt is set.
			const sql = getSql()
			const [row] = await sql<{
				pending_questions: Array<{ token: string; answers?: Record<string, string>; decidedAt?: string }>
			}[]>`
				select pending_questions from chat_runs where id = ${seeded.runId}
			`
			const entry = row.pending_questions.find((e) => e.token === seeded.token)
			expect(entry).toBeDefined()
			expect(entry!.answers).toEqual({ Color: 'green' })
			expect(entry!.decidedAt).toBeTruthy()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
