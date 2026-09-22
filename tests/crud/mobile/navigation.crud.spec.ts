import { expect, test, type Page } from '@playwright/test'
import { authenticateContext, expectNoHorizontalOverflow, waitForHydration, withErrorCapture } from '../../helpers'

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

	/** The system section is a collapsed disclosure unless you are already inside it. */
	async function openManage(drawer: ReturnType<Page['getByRole']>) {
		const toggle = drawer.getByRole('button', { name: /Manage/ })
		if ((await toggle.getAttribute('aria-expanded')) === 'true') return
		await toggle.click()
	}

	/*
	 * These two used to drive a `nav.z-20` bottom bar with Chat / Agents / More. That bar
	 * no longer exists: the console redesign moved mobile navigation into a left drawer
	 * behind the header's hamburger. Same coverage, current surface — that navigation is
	 * reachable on a phone, and that the secondary destinations are in it.
	 */
	test('the nav drawer opens from the header and navigates', async ({ page, context }) => {
		await authenticateContext(context)
		await withErrorCapture(page, async () => {
			await page.goto('/')
			await waitForHydration(page)

			const drawer = page.getByRole('dialog', { name: 'Navigation drawer' })

			await page.getByRole('button', { name: 'Open navigation' }).click()
			await expect(drawer).toBeVisible()
			// Agents sits under the "Manage" disclosure, which is collapsed unless the
			// current route is already inside it.
			await openManage(drawer)
			await drawer.getByRole('link', { name: 'Agents' }).click()
			await expect(page).toHaveURL(/\/agents$/)

			await page.getByRole('button', { name: 'Open navigation' }).click()
			await expect(drawer).toBeVisible()
			await drawer.getByRole('link', { name: 'Chats' }).click()
			await expect(page).toHaveURL(/\/$/)
		})
	})

	test('the nav drawer carries the secondary destinations', async ({ page, context }) => {
		await authenticateContext(context)
		await withErrorCapture(page, async () => {
			await page.goto('/')
			await waitForHydration(page)

			await page.getByRole('button', { name: 'Open navigation' }).click()
			const drawer = page.getByRole('dialog', { name: 'Navigation drawer' })
			await expect(drawer).toBeVisible()

			await expect(drawer.getByRole('link', { name: 'Projects' })).toBeVisible()

			await openManage(drawer)
			for (const label of ['Agents', 'Skills', 'Automations', 'Memory', 'Review', 'Settings']) {
				await expect(drawer.getByRole('link', { name: label }), `${label} is reachable`).toBeVisible()
			}
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
