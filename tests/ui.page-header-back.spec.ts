import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	expectNoHorizontalOverflow,
	seedAgent,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * Detail pages keep a way back below the desktop breakpoint.
 *
 * PageHeader rendered its back link only when the menu button was switched off, and no
 * page switches it off. The breadcrumbs that carry the parent link live in the desktop
 * topbar, which is hidden below 80rem — so on a phone or a tablet every detail page had
 * a hamburger and no way up. In an installed PWA there is not even a browser Back.
 *
 * Runs below 80rem in both projects: a phone on `mobile`, a tablet-width window on
 * `desktop`.
 */

test('a detail page has a back link beside the menu below the desktop breakpoint', async ({ page }, testInfo) => {
	if (testInfo.project.name === 'desktop') await page.setViewportSize({ width: 1024, height: 800 })

	const prefix = uniquePrefix('header-back')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const agent = await seedAgent(prefix, { name: `${prefix} Agent` })
		await page.goto(`/agents/${agent.id}/identity`)
		await waitForHydration(page)

		// The menu is still there — the back link sits beside it, not instead of it.
		await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()

		// Named after the crumb it leads to.
		const back = page.getByRole('link', { name: `Back to ${prefix} Agent` })
		await expect(back).toBeVisible()
		// A second icon in the header must not push a long title off the screen.
		await expectNoHorizontalOverflow(page)
		await back.click()
		await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`))
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
