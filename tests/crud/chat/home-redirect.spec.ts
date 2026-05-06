import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupExtendedPrefix, uniquePrefix, withErrorCapture } from '../../helpers'

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
				// Wait for hydration
				await page.waitForTimeout(2000)
				await textarea.click()
				await textarea.fill(message)
				await page.waitForTimeout(500)
				const sendBtnBefore = await page.getByRole('button', { name: 'Send message' }).isDisabled()
				console.log(`Send disabled after fill+wait: ${sendBtnBefore}`)
				await textarea.press('Enter')
				await page.waitForTimeout(2000)
				console.log(`URL after Enter: ${page.url()}`)
				expect(page.url()).toMatch(/\/chat\/[a-f0-9-]+/)

				// Should navigate to /chat/[uuid] within a few seconds
				await page.waitForURL(/\/chat\/[a-f0-9-]+/, { timeout: 10_000 })
				expect(page.url()).toMatch(/\/chat\/[a-f0-9-]+/)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
