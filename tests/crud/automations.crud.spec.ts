import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getSql,
	pollDb,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /automations — CRUD lifecycle for cron-driven automations.
 *
 * Covers create + toggle (enable/disable) + delete via the UI. The orchestrator
 * (no agentId) path is exercised so we don't need a seeded agent.
 *
 * Asserts the corresponding DB rows transition correctly + the cron expression
 * + prompt round-trip.
 */

test.describe('/automations — CRUD lifecycle', () => {
	test('create → toggle disabled → toggle enabled → delete', async ({ page, context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-autom')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const description = `${prefix} sentiment scan`
		const promptText = `${prefix} run an analysis on the latest news`
		const cron = '15 8 * * *'

		try {
			await withErrorCapture(page, async () => {
				// ── Read
				await page.goto('/automations')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: /Automations/ }).first()).toBeVisible()

				// ── Create: fill the form + click Create
				await page.getByPlaceholder('Daily customer sentiment scan').fill(description)
				const cronInput = page.getByPlaceholder('0 9 * * *')
				await cronInput.fill(cron)
				await page.getByPlaceholder('What should this automation do every run?').fill(promptText)
				await page.getByRole('button', { name: /^Create automation$/ }).click()

				// DB invariant: row created with the cron + prompt
				const created = await pollDb(
					() => sql<{ id: string; enabled: boolean; cron_expression: string }[]>`
						select id, enabled, cron_expression from automations where prompt = ${promptText}
					`,
					(rows) => rows[0]?.cron_expression === cron && rows[0]?.enabled === true,
					{ description: 'automation persisted with cron + enabled' },
				)
				const automationId = created[0].id

				// Card appears in the list (page reloads its data after create; reload to be safe)
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const card = page.locator('article').filter({ hasText: description })
				await expect(card.first()).toBeVisible({ timeout: 10_000 })

				// ── Update (toggle disabled): click Disable
				const disableBtn = card.first().getByRole('button', { name: 'Disable', exact: true })
				await disableBtn.scrollIntoViewIfNeeded()
				await disableBtn.click()
				await pollDb(
					() => sql<{ enabled: boolean }[]>`select enabled from automations where id = ${automationId}`,
					(rows) => rows[0]?.enabled === false,
					{ description: 'automation flipped to disabled' },
				)

				// ── Update (toggle enabled): click Enable
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const cardAfterDisable = page.locator('article').filter({ hasText: description })
				await cardAfterDisable.first().getByRole('button', { name: 'Enable', exact: true }).click()
				await pollDb(
					() => sql<{ enabled: boolean }[]>`select enabled from automations where id = ${automationId}`,
					(rows) => rows[0]?.enabled === true,
					{ description: 'automation flipped back to enabled' },
				)

				// ── Delete
				page.on('dialog', (d) => void d.accept())
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const cardAfterEnable = page.locator('article').filter({ hasText: description })
				await cardAfterEnable.first().getByRole('button', { name: 'Delete', exact: true }).click()
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from automations where id = ${automationId}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'automation deleted from DB' },
				)

				// Card disappears from the list (reload to pick up the post-delete state)
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const stillThere = page.locator('article').filter({ hasText: description })
				await expect(stillThere).toHaveCount(0, { timeout: 5_000 })

				// ── Layout check
				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
