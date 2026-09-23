import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedConversation,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { openAndSend, scriptHeldRun, scriptHeldSend, sse } from './chat-stream-script'

/**
 * The chat page's own state, turn to turn and conversation to conversation.
 *
 * Every run here is scripted in the browser (`chat-stream-script.ts`), so no model is
 * involved: `/chat/[id]/stream` answers with the frames a test needs, and a held request
 * keeps the page mid-turn until the test lets go.
 */

const isStream = (conversationId: string) => (url: URL) => url.pathname === `/chat/${conversationId}/stream`

async function seedEmptyConversation(prefix: string) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} empty`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`
	return conversation
}

async function messageRows(conversationId: string) {
	return getSql()<{ role: string; content: string }[]>`
		select role, content from messages where conversation_id = ${conversationId} order by sequence
	`
}

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' }).filter({ visible: true })

test.describe('switching conversations mid-turn (#74)', () => {
	test("another chat opened mid-reply shows none of the first chat's turn, and nothing is written to it", async ({
		page,
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'switches chats from the desktop sidebar; the page itself is the same on mobile')
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-switch')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		const first = await seedConversation(prefix, { userId, title: `${prefix} first`, userMessage: `${prefix} first q` })
		const second = await seedConversation(prefix, {
			userId,
			title: `${prefix} second`,
			userMessage: `${prefix} second q`,
			assistantMessage: `${prefix} second answer`,
		})
		const { seen, release } = await scriptHeldRun(page, first.id, [
			{ id: 1, event: 'context_stats', data: { runId: randomUUID(), tokenEstimate: 10, contextWindow: 200_000 } },
			{ event: 'delta', data: { content: `${prefix} half-written reply` } },
		])

		try {
			await openAndSend(page, first.id, `${prefix} a long job`)
			await expect.poll(() => seen.resumes, { timeout: 30_000 }).toBe(1)
			await expect(page.getByText(`${prefix} half-written reply`).first()).toBeVisible()
			await expect(stopButton(page).first()).toBeVisible()

			await page.locator(`a.console-chatrow[href="/chat/${second.id}"]`).first().click()
			await expect(page).toHaveURL(new RegExp(`/chat/${second.id}$`))
			await expect(page.getByText(`${prefix} second answer`).first()).toBeVisible({ timeout: 30_000 })

			// None of the first conversation's turn came along.
			await expect(stopButton(page)).toHaveCount(0)
			await expect(page.getByText(`${prefix} half-written reply`)).toHaveCount(0)
			await expect(page.getByRole('main').getByText(`${prefix} a long job`)).toHaveCount(0)
			// The page let go of the first run's stream; leaving is not a Stop.
			await expect.poll(() => seen.resumeAborted).toBe(true)
			expect(seen.stops).toEqual([])

			// The first run ending now reaches no page, so it writes nothing anywhere: the
			// run saves its own reply, and the second conversation is left alone.
			release()
			await page.waitForTimeout(1500)
			expect(await messageRows(second.id)).toEqual([
				{ role: 'user', content: `${prefix} second q` },
				{ role: 'assistant', content: `${prefix} second answer` },
			])
			expect(await messageRows(first.id)).toHaveLength(2)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('the ?prompt= handoff (#75)', () => {
	test('the prompt leaves the URL before the reply, so a reload does not send it again', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-prompt-once')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedEmptyConversation(prefix)
		const { seen, release } = await scriptHeldSend(page, conversation.id)
		const prompt = `${prefix} first question`

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conversation.id}?prompt=${encodeURIComponent(prompt)}`, {
				waitUntil: 'domcontentloaded',
			})
			await expect.poll(() => seen.sends.length, { timeout: 30_000 }).toBe(1)
			expect(seen.sends[0]).toMatchObject({ content: prompt, attachments: [] })
			// Still mid-reply, and the prompt is already gone from the address.
			await expect(page).toHaveURL(new RegExp(`/chat/${conversation.id}$`))

			await page.reload({ waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			await page.waitForTimeout(1500)
			expect(seen.sends).toHaveLength(1)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a conversation that already has messages does not send the prompt', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-prompt-existing')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, {
			userId: await getActiveUserId(),
			assistantMessage: `${prefix} earlier answer`,
		})
		const { seen, release } = await scriptHeldSend(page, conversation.id)

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conversation.id}?prompt=${encodeURIComponent(`${prefix} again`)}`, {
				waitUntil: 'domcontentloaded',
			})
			await expect(page.getByText(`${prefix} earlier answer`).first()).toBeVisible({ timeout: 30_000 })
			await expect(page).toHaveURL(new RegExp(`/chat/${conversation.id}$`))
			await page.waitForTimeout(1500)
			expect(seen.sends).toEqual([])
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('moving on mid-reply stays put when the reply ends', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'moves on through the desktop sidebar; the page itself is the same on mobile')
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-prompt-leave')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedEmptyConversation(prefix)
		const { seen, release } = await scriptHeldSend(page, conversation.id)

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conversation.id}?prompt=${encodeURIComponent(`${prefix} q`)}`, {
				waitUntil: 'domcontentloaded',
			})
			await expect.poll(() => seen.sends.length, { timeout: 30_000 }).toBe(1)

			await page.locator('a.console-nav-item[href="/projects"]').first().click()
			await expect(page).toHaveURL(/\/projects$/)

			release()
			await page.waitForTimeout(2000)
			await expect(page).toHaveURL(/\/projects$/)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a file attached on the new-chat page is sent with the first message (#59)', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-home-attach')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const attachment = {
			id: randomUUID(),
			filename: 'screenshot.png',
			mimeType: 'image/png',
			size: 68,
			url: `/api/upload/${randomUUID()}.png`,
		}
		const sends: Array<Record<string, unknown>> = []
		await page.route('**/api/upload', (route) => route.fulfill({ json: attachment }))
		await page.route(
			(url) => /^\/chat\/[^/]+\/stream$/.test(url.pathname),
			(route) => {
				sends.push(route.request().postDataJSON())
				return route.fulfill({
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
					body: sse([{ id: 1, event: 'done', data: { error: 'scripted end' } }]),
				})
			},
		)

		try {
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			await page.locator('input[type="file"]').first().setInputFiles({
				name: attachment.filename,
				mimeType: attachment.mimeType,
				buffer: Buffer.from('not really a png'),
			})
			await expect(page.getByText(attachment.filename).first()).toBeVisible()

			const composer = page.getByPlaceholder('Start a new conversation...')
			await composer.fill(`${prefix} what is wrong here?`)
			await page.getByRole('button', { name: /send message/i }).first().click()

			await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(1)
			expect(sends[0]).toMatchObject({ content: `${prefix} what is wrong here?`, attachments: [attachment] })
		} finally {
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test('a reply saved with an error is not saved again as a partial (#76)', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-done-error')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conversation = await seedConversation(prefix, {
		userId: await getActiveUserId(),
		assistantMessage: `${prefix} the saved reply`,
	})
	const [saved] = await getSql()<{ id: string }[]>`
		select id from messages where conversation_id = ${conversation.id} and role = 'assistant'
	`
	await page.route(isStream(conversation.id), (route) =>
		route.fulfill({
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
			body: sse([
				{ id: 1, event: 'context_stats', data: { runId: randomUUID(), tokenEstimate: 10, contextWindow: 200_000 } },
				{ event: 'delta', data: { content: `${prefix} the reply as it streamed` } },
				// The server saved the reply and the turn ended in an error: max turns, an
				// overloaded API. The message id and the error come together.
				{ id: 2, event: 'done', data: { messageId: saved.id, error: 'Reached the maximum number of turns (20)' } },
			]),
		}),
	)

	try {
		await openAndSend(page, conversation.id, `${prefix} keep going`)
		await expect(page.getByText(/maximum number of turns/).first()).toBeVisible({ timeout: 30_000 })
		await expect(stopButton(page)).toHaveCount(0)
		await page.waitForTimeout(1500)

		const assistants = (await messageRows(conversation.id)).filter((row) => row.role === 'assistant')
		expect(assistants).toEqual([{ role: 'assistant', content: `${prefix} the saved reply` }])
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})
