import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, authenticateContext, cleanupExtendedPrefix, uniquePrefix, withErrorCapture } from '../../helpers'

/**
 * Takes the same lock the budget specs use. Anything that runs the model has to: a
 * budget spec installing a $0.01 cap while this streams turns it into a 402 that looks
 * like a product failure. See `acquireGlobalStateLock` in helpers.
 */
let releaseBudgetLock: (() => Promise<void>) | null = null
test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
})
test.afterEach(async () => {
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

test.describe('home — chat submit redirect', () => {
	test('submitting at / creates a conversation and navigates to /chat/[id]', async ({ page, context }) => {
		test.setTimeout(30_000)
		const prefix = uniquePrefix('home-redirect')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)

		try {
			await withErrorCapture(page, async () => {
				await page.goto('/')
				await page.waitForLoadState('domcontentloaded')

				const message = `${prefix} hello world`
				const textarea = page.locator('#chat-composer-textarea')
				await textarea.waitFor({ state: 'visible', timeout: 5_000 })

				await textarea.click()
				await textarea.fill(message)

				// Wait on state, not on the clock. This used to sleep 2s for hydration, 500ms
				// after filling and 2s after Enter, then assert the URL had already changed —
				// which held up when the spec ran alone and failed under eight workers. The
				// Send button is disabled until the client has hydrated *and* seen the draft,
				// so it becoming enabled is the real signal that Enter will do anything.
				const send = page.getByRole('button', { name: 'Send message' })
				await expect(send).toBeEnabled({ timeout: 10_000 })

				await textarea.press('Enter')

				// Creating the conversation is a round trip; wait for the navigation rather
				// than asserting the URL has already changed.
				await page.waitForURL(/\/chat\/[a-f0-9-]+/, { timeout: 15_000 })
				expect(page.url()).toMatch(/\/chat\/[a-f0-9-]+/)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})

test.describe('/chat — legacy index route', () => {
	test('/chat redirects to the chat console at /', async ({ page, context }) => {
		await authenticateContext(context)

		// `/chat` used to be a list page. It is a redirector now, and the only assertion
		// worth making about it is that it redirects. This lived in visual.spec.ts, where
		// it took no screenshot and checked for a "Chats" heading belonging to
		// RecentChats.svelte — a component nothing imports.
		await page.goto('/chat')
		await page.waitForURL(/\/$/, { timeout: 15_000 })
		await expect(page.getByPlaceholder('Start a new conversation...')).toBeVisible()
	})
})
