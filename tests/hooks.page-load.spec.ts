import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'

/**
 * Wave 3 #13 phase 5 — /settings/hooks page-load smoke.
 *
 * Triggered by a real-world report: production page errored with 500 from the remote query.
 * This test loads the page, captures any 500 responses + console errors, and surfaces them so
 * regressions don't ship silently.
 */

test.describe('settings/hooks — page load smoke', () => {
	test('page loads without 500 + remote query returns', async ({ page, context }) => {
		await authenticateContext(context)

		const errorResponses: Array<{ url: string; status: number; body: string }> = []
		page.on('response', async (resp) => {
			if (resp.status() >= 500) {
				let body = ''
				try {
					body = await resp.text()
				} catch {
					body = '<no body>'
				}
				errorResponses.push({ url: resp.url(), status: resp.status(), body: body.slice(0, 500) })
			}
		})

		const consoleErrors: string[] = []
		page.on('pageerror', (err) => {
			consoleErrors.push(err.message)
		})
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text())
		})

		await page.goto('/settings/hooks')
		await page.waitForLoadState('domcontentloaded')

		// Wait for the loading state to finish.
		await expect(page.getByText('Loading…').first()).toBeHidden({ timeout: 10_000 }).catch(() => null)

		// Heading must render.
		await expect(page.getByRole('heading', { name: /Hook invocations/i })).toBeVisible({ timeout: 10_000 })

		// Surface every 500 + console error so we see the root cause in the test report.
		expect(
			errorResponses.length,
			`Got ${errorResponses.length} 5xx responses:\n${errorResponses
				.map((r) => `  ${r.status} ${r.url}\n  body: ${r.body}`)
				.join('\n')}`,
		).toBe(0)
		expect(
			consoleErrors.length,
			`Got ${consoleErrors.length} console errors:\n${consoleErrors.join('\n')}`,
		).toBe(0)
	})
})
