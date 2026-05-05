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
 * /research + /research/[id] CRUD lifecycle (real LLM).
 *
 * Starts a research run from the form on /research, asserts the row appears in
 * `research` with status='planning' or beyond, then cancels via the detail page
 * and asserts status='canceled' persists.
 */

test.describe('/research — CRUD lifecycle (real LLM)', () => {
	test('start from form → assert row created → cancel → assert canceled', async ({ page, context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('crud-research')
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		const query = `${prefix} compare lithium-ion vs lithium-polymer batteries for portable devices`

		try {
			await withErrorCapture(page, async () => {
				// ── Read /research
				await page.goto('/research')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: /Research/ }).first()).toBeVisible()

				// ── Create: open form + fill query + start
				await page.getByRole('button', { name: '+ New research' }).click()
				await page.getByPlaceholder('e.g. Compare lithium iron phosphate vs lithium polymer batteries for efoils').fill(query)
				await page.getByRole('button', { name: 'Start research' }).click()

				// Should redirect to /research/[id]
				await page.waitForURL(/\/research\/[0-9a-f-]+$/, { timeout: 10_000 })

				// DB invariant: research row created for our user with our query
				const researchRow = await pollDb(
					() => sql<{ id: string; status: string }[]>`
						select id, status::text as status from research
						where user_id = ${userId} and query = ${query}
					`,
					(rs) => rs.length === 1,
					{ description: 'research row created' },
				)
				const researchId = researchRow[0].id

				// ── Cancel via the detail page
				page.on('dialog', (d) => void d.accept())
				await page.getByRole('button', { name: /Cancel/ }).first().click()
				await pollDb(
					() => sql<{ status: string }[]>`select status::text as status from research where id = ${researchId}`,
					(rs) => rs[0]?.status === 'canceled',
					{ description: 'research canceled', timeoutMs: 30_000 },
				)

				// ── Layout
				if (test.info().project.name !== 'mobile') {
					await expectNoHorizontalOverflow(page, {
						ignoreSelectors: ['pre', 'pre *', 'code', 'code *', '.overflow-x-auto', '.overflow-x-auto *'],
					})
				}
			})
		} finally {
			// Clean up the research row + any spawned jobs
			await sql`delete from research where query like ${`${prefix}%`}`
			await sql`delete from jobs where dedupe_key like ${`%${prefix}%`}`
		}
	})
})
