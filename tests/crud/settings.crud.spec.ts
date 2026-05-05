import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	expectNoHorizontalOverflow,
	getActiveAdminUserId,
	getSql,
	pollDb,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /settings — read defaults, update budget + memory + tool config, reset.
 *
 * Asserts each mutation persists to the `app_settings` table for the active admin
 * user AND that an `audit_events` row is written (settings.updated / settings.reset)
 * via the existing governance wrappers.
 */

test.describe('/settings — CRUD lifecycle', () => {
	test('read → update budget + memory → reset', async ({ page, context }) => {
		const prefix = uniquePrefix('crud-settings')
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveAdminUserId()

		// Snapshot the current settings so the reset assertion can compare back to defaults
		// regardless of what the admin had configured before the test ran.
		const [snapshot] = await sql<
			{
				default_model: string
				budget_config: { dailyLimit: number | null; monthlyLimit: number | null } | null
				memory_config: { topK: number; enabled: boolean } | null
			}[]
		>`select default_model, budget_config, memory_config from app_settings where user_id = ${userId}`

		try {
			await withErrorCapture(page, async () => {
				// ── Read
				await page.goto('/settings')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: 'Settings', exact: true }).first()).toBeVisible()

				// ── Update: change daily budget cap to a unique sentinel value.
				// The Daily limit / Monthly limit inputs are the only number inputs with the
				// "No limit" placeholder, so target by placeholder.
				const sentinelDaily = 12.34
				const limitInputs = page.locator('input[type="number"][placeholder="No limit"]')
				await expect(limitInputs.first()).toBeVisible()
				await limitInputs.nth(0).fill(String(sentinelDaily))
				await limitInputs.nth(0).blur()

				// Update memory topK to a sentinel value via the unique min=1 max=20 attrs.
				const memoryTopK = 7
				const topKInput = page.locator('input[type="number"][min="1"][max="20"]').first()
				await topKInput.fill(String(memoryTopK))
				await topKInput.blur()

				// Click save
				await page.getByRole('button', { name: /^Save$/, exact: true }).click()

				// DB invariant: budget + memory persisted
				await pollDb(
					() => sql<{ budget_config: { dailyLimit: number | null }; memory_config: { topK: number } }[]>`
						select budget_config, memory_config from app_settings where user_id = ${userId}
					`,
					(rows) =>
						rows[0]?.budget_config?.dailyLimit === sentinelDaily &&
						rows[0]?.memory_config?.topK === memoryTopK,
					{ description: 'settings update persists daily limit + memory topK' },
				)

				// Audit invariant: settings.updated row written
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from audit_events
						where action = 'settings.updated'::audit_action
						  and target_id = ${userId}
						  and created_at >= now() - interval '1 minute'
					`,
					(rows) => (rows[0]?.count ?? 0) >= 1,
					{ description: 'audit_events row for settings.updated' },
				)

				// ── Reset: click Reset
				await page.getByRole('button', { name: 'Reset' }).click()
				await pollDb(
					() => sql<{ budget_config: { dailyLimit: number | null } | null }[]>`
						select budget_config from app_settings where user_id = ${userId}
					`,
					(rows) => rows[0]?.budget_config?.dailyLimit !== sentinelDaily,
					{ description: 'reset wiped the sentinel daily limit' },
				)

				// Audit invariant: settings.reset row written
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from audit_events
						where action = 'settings.reset'::audit_action
						  and target_id = ${userId}
						  and created_at >= now() - interval '1 minute'
					`,
					(rows) => (rows[0]?.count ?? 0) >= 1,
					{ description: 'audit_events row for settings.reset' },
				)

				// ── Layout check
				await expectNoHorizontalOverflow(page, {
					ignoreSelectors: ['pre', 'pre *', '.overflow-x-auto', '.overflow-x-auto *'],
				})
			})
		} finally {
			// Best-effort restore of pre-test settings via direct SQL (don't poll the UI for this).
			if (snapshot) {
				await sql`
					update app_settings
					set default_model = ${snapshot.default_model},
					    budget_config = ${sql.json(snapshot.budget_config ?? {})},
					    memory_config = ${sql.json(snapshot.memory_config ?? {})}
					where user_id = ${userId}
				`
			}
			// Suppress unused-var warning
			void prefix
		}
	})
})
