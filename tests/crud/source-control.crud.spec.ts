import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getActiveAdminUserId,
	getSql,
	pollDb,
	seedGithubConnection,
	seedRepository,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /source-control CRUD lifecycle.
 *
 * Token-injection only (the GitHub OAuth dance can't run in CI). We seed an
 * encrypted-token row directly to simulate post-OAuth state, plus a synced
 * repository row, then exercise:
 *   - List: connection + repos visible
 *   - Disconnect: status flips to revoked + token cleared
 *
 * `sync_my_repos` itself isn't exercised (would hit live GitHub).
 */

test.describe('/source-control — CRUD lifecycle (token-injection)', () => {
	test('seed connection + repo → page renders → disconnect flips status', async ({ page, context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-sc')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveAdminUserId()

		const conn = await seedGithubConnection(prefix, userId)
		const repo = await seedRepository(prefix, userId, {
			owner: 'derekhearst',
			name: `${prefix}-AgentStudio`.toLowerCase(),
		})

		try {
			await withErrorCapture(page, async () => {
				// ── Read /source-control
				await page.goto('/source-control')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: 'Source control', exact: true })).toBeVisible()

				// Connection card shows the seeded provider account
				await expect(page.getByText(conn.providerAccount, { exact: false })).toBeVisible({ timeout: 8_000 })
				await expect(page.locator('.badge', { hasText: 'active' }).first()).toBeVisible()

				// Synced repos table shows the seeded repo
				await expect(page.getByText(`${repo.owner}/${repo.name}`, { exact: false })).toBeVisible()

				// ── Update: disconnect (button asks confirm)
				page.on('dialog', (d) => void d.accept())
				await page.getByRole('button', { name: 'Disconnect' }).click()
				await pollDb(
					() => sql<{ status: string; encrypted_token: string }[]>`
						select status::text as status, encrypted_token from repository_connections
						where user_id = ${userId} and provider_account = ${conn.providerAccount}
					`,
					(rows) => rows[0]?.status === 'revoked' && rows[0]?.encrypted_token === '',
					{ description: 'connection revoked + token cleared' },
				)

				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
