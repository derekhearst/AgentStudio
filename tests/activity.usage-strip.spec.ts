import { expect, test } from '@playwright/test'
import { authenticateContext, expectNoHorizontalOverflow, waitForHydration } from './helpers'

/**
 * #38 — the usage strip on /activity.
 *
 * What the numbers add up to is pinned in `costs.usage-digest.spec.ts` (pure) and
 * `costs.usage-digest-live.spec.ts` (the queries). This file pins the page: the strip is
 * there above the feed, the window switch reloads it, and it fits a phone.
 *
 * The weekly-digest opt-in is only checked for being present — pressing it would create a
 * real automation on this instance; the live spec covers what it does.
 */

test.describe('activity/usage-strip', () => {
	test('the strip leads the page, a week by default, and the window switch reloads it', async ({ page }) => {
		test.setTimeout(60_000)
		await authenticateContext(page.context())
		await page.goto('/activity', { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)

		const strip = page.getByTestId('usage-strip')
		await expect(strip.getByRole('heading', { name: 'Last 7 days' })).toBeVisible({ timeout: 20_000 })
		for (const tile of ['usage-runs', 'usage-tokens', 'usage-automations', 'usage-inbox', 'usage-budget', 'usage-tools']) {
			await expect(strip.getByTestId(tile), tile).toBeVisible()
		}
		// Tokens lead; dollars are labelled metered.
		await expect(strip.getByTestId('usage-metered')).toContainText('metered')
		// Budget headroom is a percentage or says there is nothing to measure against.
		await expect(strip.getByTestId('usage-budget')).toContainText(/%|No limits set/)
		await expect(strip.getByTestId('weekly-digest')).toBeVisible()

		// The strip sits above the feed's filters, not below 100 events.
		const stripBox = await strip.boundingBox()
		const filterBox = await page.getByRole('button', { name: 'All', exact: true }).boundingBox()
		expect(stripBox && filterBox && stripBox.y < filterBox.y).toBe(true)

		const toggle = strip.getByTestId('usage-window-30')
		await toggle.click()
		await expect(strip.getByRole('heading', { name: 'Last 30 days' })).toBeVisible({ timeout: 20_000 })
		await expect(toggle).toHaveAttribute('aria-pressed', 'true')
		await expect(strip.getByTestId('usage-window-7')).toHaveAttribute('aria-pressed', 'false')

		await strip.getByTestId('usage-window-1').click()
		await expect(strip.getByRole('heading', { name: 'Last 24 hours' })).toBeVisible({ timeout: 20_000 })
	})

	test('the window switch is reachable at tablet width', async ({ page }) => {
		// Page-header actions are not shown between the phone and desktop breakpoints, which
		// is why the switch lives in the strip rather than the header.
		test.setTimeout(60_000)
		await page.setViewportSize({ width: 1024, height: 900 })
		await authenticateContext(page.context())
		await page.goto('/activity', { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)

		const strip = page.getByTestId('usage-strip')
		await expect(strip.getByTestId('usage-window-30')).toBeVisible({ timeout: 20_000 })
		await strip.getByTestId('usage-window-30').click()
		await expect(strip.getByRole('heading', { name: 'Last 30 days' })).toBeVisible({ timeout: 20_000 })
	})

	test('the strip fits a phone without sideways scrolling', async ({ page }) => {
		test.setTimeout(60_000)
		await page.setViewportSize({ width: 375, height: 812 })
		await authenticateContext(page.context())
		await page.goto('/activity', { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)

		const strip = page.getByTestId('usage-strip')
		await expect(strip.getByTestId('usage-runs')).toBeVisible({ timeout: 20_000 })
		// Two tiles to a row on a phone.
		const runs = await strip.getByTestId('usage-runs').boundingBox()
		const tokens = await strip.getByTestId('usage-tokens').boundingBox()
		expect(runs && tokens && Math.abs(runs.y - tokens.y) < 2).toBe(true)

		await expect(strip.getByTestId('usage-window-7')).toBeVisible()
		await expectNoHorizontalOverflow(page)
	})
})
