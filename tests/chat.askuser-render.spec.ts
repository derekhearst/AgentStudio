import { expect, test, type Page } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

async function seedAskUserConversation(prefix: string) {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users
		where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} render`}, ${user.id}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`

	const [userMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (${conversation.id}, 'user', 'Ask a question', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb)
		returning id
	`

	const askUserArguments = {
		questions: [
			{
				header: 'Color',
				question: 'What is your favorite color',
				options: [
					{ label: 'green', description: 'A calming color' },
					{ label: 'blue', description: 'A serene color' },
				],
				allowFreeformInput: false,
			},
		],
	}
	const askUserResult = {
		questions: askUserArguments.questions,
		answers: { Color: 'green' },
		timedOut: false,
	}

	const blocks = [
		{
			kind: 'tool',
			name: 'ask_user',
			arguments: askUserArguments,
			result: askUserResult,
			success: true,
			executionMs: 0,
		},
		{ kind: 'text', content: "that's great" },
	]
	const toolCalls = [
		{
			name: 'ask_user',
			arguments: askUserArguments,
			result: askUserResult,
			executionMs: 0,
		},
	]

	const [assistantMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, model, parent_message_id, metadata, tool_calls)
		values (
			${conversation.id},
			'assistant',
			${"that's great"},
			${'anthropic/claude-sonnet-4'},
			${userMsg.id},
			${sql.json({ blocks })},
			${sql.json(toolCalls)}
		)
		returning id
	`

	return { conversationId: conversation.id, userMsgId: userMsg.id, assistantMsgId: assistantMsg.id }
}

async function getRenderedTextSequence(page: Page, texts: string[]): Promise<{ y: number; text: string }[]> {
	return Promise.all(
		texts.map(async (t) => {
			const el = page.getByText(t, { exact: false }).first()
			await el.waitFor({ state: 'visible' })
			const box = await el.boundingBox()
			return { y: box?.y ?? Number.POSITIVE_INFINITY, text: t }
		}),
	)
}

test.describe('chat/ask_user — rendered as alternating user/assistant bubbles after reload', () => {
	test('user prompt → assistant question → user answer → assistant continuation render in that order', async ({
		page,
	}) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-askuser-render')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const seeded = await seedAskUserConversation(prefix)
			// Warm up vite's dep optimizer with a root request so the first chat-detail navigation
			// doesn't race against `504 Outdated Optimize Dep` on dynamic imports.
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${seeded.conversationId}`, { waitUntil: 'domcontentloaded' })
			// Wait for the user message bubble to actually render — getConversation() is async.
			await page.getByText('Ask a question', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })

			// Scope to the main chat area; the sidebar shows snippet text that would otherwise collide.
			const main = page.getByRole('main')
			const askPrompt = main.getByText('Ask a question', { exact: true }).first()
			const askQuestion = main.getByText('What is your favorite color', { exact: false }).first()
			const userAnswer = main.getByText('green', { exact: true }).first()
			const assistantContinuation = main.getByText("that's great", { exact: false }).first()

			await expect(askPrompt).toBeVisible()
			await expect(askQuestion).toBeVisible()
			await expect(userAnswer).toBeVisible()
			await expect(assistantContinuation).toBeVisible()

			const sequence = await getRenderedTextSequence(page, [
				'Ask a question',
				'What is your favorite color',
				'green',
				"that's great",
			])
			const orderedTexts = [...sequence].sort((a, b) => a.y - b.y).map((s) => s.text)
			expect(orderedTexts).toEqual([
				'Ask a question',
				'What is your favorite color',
				'green',
				"that's great",
			])

			// Role styling check: prompt and answer should sit inside user-styled containers
			// (border-primary/25 bg-base-100/72), question and continuation inside assistant-styled
			// containers (.assistant-message). MessageBubble wraps the whole assistant article in
			// a non-chat-end <article>, so we identify user-side bubbles by their primary border class.
			const promptBubble = askPrompt.locator(
				'xpath=ancestor::div[contains(@class, "border-primary/25")][1]',
			)
			await expect(promptBubble).toBeVisible()
			const answerBubble = userAnswer.locator(
				'xpath=ancestor::div[contains(@class, "border-primary/25")][1]',
			)
			await expect(answerBubble).toBeVisible()

			const questionBubble = askQuestion.locator('xpath=ancestor::div[contains(@class, "assistant-message")][1]')
			await expect(questionBubble).toBeVisible()
			const continuationBubble = assistantContinuation.locator(
				'xpath=ancestor::div[contains(@class, "assistant-message")][1]',
			)
			await expect(continuationBubble).toBeVisible()

			// Original user message must remain inside an article rendered with chat-end (right-aligned).
			const userArticle = askPrompt.locator('xpath=ancestor::article[1]')
			await expect(userArticle).toHaveClass(/chat-end/)

			// Nothing got deleted: both DB rows persist after page render.
			const sql = getSql()
			const remaining = await sql<{ id: string; role: string }[]>`
				select id, role from messages where conversation_id = ${seeded.conversationId}
			`
			expect(remaining.map((r) => r.role).sort()).toEqual(['assistant', 'user'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
