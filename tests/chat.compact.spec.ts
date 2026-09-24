import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	seedConversation,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { sse } from './chat-stream-script'
import { COMPACT_INSTRUCTIONS, compactCommand, compactSwitchNotice } from '../src/lib/chat/compact-command'

/**
 * Finding 80: "Compact Conversation" runs the CLI's own `/compact`, which really replaces the
 * session's history with a summary. It used to post an ordinary message asking the model for
 * a summary, which the session then carried on top of the history it was meant to replace.
 *
 * The run is scripted in the browser, so no model is involved; what matters is what the page
 * sends.
 */

test.describe('the /compact prompt', () => {
	test('is the command itself, first thing in the prompt, with what to keep', () => {
		expect(compactCommand()).toBe(`/compact ${COMPACT_INSTRUCTIONS}`)
		const handoff = compactCommand({ handoff: true })
		expect(handoff.startsWith('/compact ')).toBe(true)
		expect(handoff).toContain('smaller context window')
	})

	test('the notice before a model switch says whether the compaction happened', () => {
		expect(compactSwitchNotice({ failed: false, from: 'anthropic/claude-opus-4', to: 'anthropic/claude-haiku-4' })).toBe(
			'Compacted the conversation on claude-opus-4 before switching to claude-haiku-4.',
		)
		expect(compactSwitchNotice({ failed: true, from: 'anthropic/claude-opus-4', to: 'anthropic/claude-haiku-4' })).toBe(
			'Compacting before the switch to claude-haiku-4 failed; the full conversation is still in context.',
		)
	})
})

test('Compact Conversation sends /compact as a new turn, not a request for a summary', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-compact')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conversation = await seedConversation(prefix, {
		userId: await getActiveUserId(),
		userMessage: `${prefix} What is 2+2?`,
		assistantMessage: `${prefix} 4`,
	})
	const sends: Array<{ content?: string; regenerate?: boolean }> = []
	await page.route(
		(url) => url.pathname === `/chat/${conversation.id}/stream`,
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
		// The context ring with its Compact button sits in the phone and tablet header.
		const viewport = page.viewportSize()!
		if (viewport.width >= 1280) await page.setViewportSize({ width: 1024, height: viewport.height })
		await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)

		await page.getByRole('button', { name: /Context window usage/ }).filter({ visible: true }).first().click()
		const compact = page.getByRole('button', { name: 'Compact Conversation' }).filter({ visible: true }).first()
		await expect(compact).toBeVisible()
		await compact.click()

		await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(1)
		expect(sends[0].regenerate).toBe(false)
		expect(sends[0].content).toBe(compactCommand())
		expect(sends[0].content?.startsWith('/compact ')).toBe(true)
		expect(sends[0].content).not.toContain('Please compact this conversation')
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})
