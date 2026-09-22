import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, uniquePrefix } from './helpers'

/**
 * Screenshot comparison, and nothing else.
 *
 * Baselines are per-platform (`-linux.png`, `-win32.png`) because font rendering differs.
 * CI runs on Linux, so the Linux set is the one that gates a build; the Windows set is a
 * convenience for running this locally. Regenerate either with `--update-snapshots`, and
 * the Linux set specifically via the `update_snapshots` input on the Tests workflow —
 * generating it anywhere but the CI runner produces a baseline that does not match the
 * machine doing the comparing.
 *
 * This file previously also held a "visual regression: chat index" test that took no
 * screenshot. It asserted a "Chats" heading that lives in RecentChats.svelte — a
 * component imported nowhere — against `/chat`, which is now a redirector to `/`. The
 * redirect it should have been checking is covered in crud/chat/home-redirect.spec.ts.
 */

test('visual regression: settings page', async ({ page }) => {
	const prefix = uniquePrefix('visual-settings')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await page.goto('/settings')
		await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
		await expect(page.locator('main')).toHaveScreenshot('settings-main.png', {
			animations: 'disabled',
			maxDiffPixelRatio: 0.05,
		})
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
