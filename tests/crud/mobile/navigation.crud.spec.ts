import { expect, test } from '@playwright/test'
import { authenticateContext, expectNoHorizontalOverflow, withErrorCapture } from '../../helpers'

/**
 * Mobile-only navigation + composer + scroll checks.
 *
 * Skipped on desktop. Catches:
 *   - Bottom-nav routes correctly
 *   - "More" popover opens + secondary nav links are reachable
 *   - Long pages don't have whole-page horizontal scroll (only intentional
 *     scroll inside `.overflow-x-auto`)
 */

test.describe('mobile — navigation + layout', () => {
	test.beforeEach(({}, testInfo) => {
		if (testInfo.project.name !== 'mobile') {
			test.skip(true, 'mobile-only')
		}
	})

	test('bottom nav: Chat + Agents tap navigates correctly', async ({ page, context }) => {
		await authenticateContext(context)
		await withErrorCapture(page, async () => {
			await page.goto('/')
			await page.waitForLoadState('domcontentloaded')

			// Mobile bottom nav has Chat + Agents + More
			await page.locator('nav.z-20').getByRole('link', { name: 'Agents' }).click()
			await expect(page).toHaveURL(/\/agents$/)

			await page.locator('nav.z-20').getByRole('link', { name: 'Chat' }).click()
			await expect(page).toHaveURL(/\/$/)
		})
	})

	test('More dropdown: secondary nav links reachable', async ({ page, context }) => {
		await authenticateContext(context)
		await withErrorCapture(page, async () => {
			await page.goto('/')
			await page.waitForLoadState('domcontentloaded')

			// Open the More dropdown
			await page.locator('nav.z-20').getByRole('button', { name: /More/ }).click()

			// Each link in the DaisyUI dropdown content should be visible
			const dropdown = page.locator('nav.z-20 .dropdown-content')
			await expect(dropdown).toBeVisible({ timeout: 3_000 })
			await expect(dropdown.getByRole('link', { name: 'Activity' })).toBeVisible()
			await expect(dropdown.getByRole('link', { name: 'Skills' })).toBeVisible()
			await expect(dropdown.getByRole('link', { name: 'Review' })).toBeVisible()
			await expect(dropdown.getByRole('link', { name: 'Settings' })).toBeVisible()
		})
	})

	test('static read-only pages do not horizontally overflow on mobile', async ({ page, context }) => {
		await authenticateContext(context)
		// Routes that should fit cleanly on a 412px-wide viewport.
		const safeRoutes = ['/agents', '/skills', '/automations', '/tasks', '/projects', '/review', '/audit', '/users', '/source-control']
		for (const route of safeRoutes) {
			await test.step(route, async () => {
				await withErrorCapture(page, async () => {
					await page.goto(route)
					await page.waitForLoadState('domcontentloaded')
					// Wait for loading state to clear before checking layout
					await expect(page.getByText('Loading…').first()).toBeHidden({ timeout: 10_000 }).catch(() => null)
					await page.waitForTimeout(300)
					await expectNoHorizontalOverflow(page, {
						ignoreSelectors: [
							'pre',
							'pre *',
							'code',
							'code *',
							'.overflow-x-auto',
							'.overflow-x-auto *',
							'table',
							'table *',
							'.modal',
							'.modal *',
							'[popover]',
							'[popover] *',
						],
					})
				})
			})
		}
	})
})
