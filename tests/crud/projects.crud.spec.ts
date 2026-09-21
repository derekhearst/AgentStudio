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
 * /projects + /projects/[id] CRUD lifecycle.
 *
 * Covers:
 *   - Create project via form on /projects
 *   - Open the project detail page
 *   - Delete project
 *
 * Documents used to be a second half of this lifecycle (create artifact → edit → rollback
 * → soft-delete). Artifacts are gone: the agent writes real files into the project's
 * working directory, so the repo view owns that surface now.
 */

test.describe('/projects — CRUD lifecycle', () => {
	test('create project → open detail → delete project', async ({ page, context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-projects')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const projectName = `${prefix} Project`

		// Auto-accept every confirm() dialog (delete project uses confirm).
		page.on('dialog', (d) => void d.accept())

		try {
			await withErrorCapture(page, async () => {
				// ── Create project
				await page.goto('/projects')
				await page.waitForLoadState('domcontentloaded')
				await page.getByRole('button', { name: '+ New project' }).click()
				await page.getByPlaceholder('e.g. Efoil Rebuild').fill(projectName)
				await page.getByRole('button', { name: 'Create', exact: true }).click()

				const projectRow = await pollDb(
					() => sql<{ id: string; slug: string }[]>`
						select id, slug from projects where name = ${projectName}
					`,
					(rows) => rows.length === 1,
					{ description: 'project created via UI' },
				)
				const projectId = projectRow[0].id

				// ── Read project detail
				await page.goto(`/projects/${projectId}`)
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByText(projectName, { exact: false }).first()).toBeVisible()

				// ── Delete project (via UI on /projects). Delete button is hover-revealed.
				await page.goto('/projects')
				await page.waitForLoadState('domcontentloaded')
				const projectCard = page.locator('div').filter({ hasText: projectName }).first()
				await projectCard.locator('button', { hasText: 'Delete' }).first().click()
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from projects where id = ${projectId}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'project deleted from DB' },
				)

				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
