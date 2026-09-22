import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupExtendedPrefix, expectNoHorizontalOverflow, getSql, pollDb, uniquePrefix, waitForHydration, withErrorCapture } from '../helpers'

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
				await waitForHydration(page)
				await page.getByRole('button', { name: '+ New project' }).click()
				await page.getByPlaceholder('e.g. Efoil Rebuild').fill(projectName)
				// The modal has a tab per repo mode and the submit button names the mode:
				// "Create empty project" on the default (no filesystem, no git repo).
				await page.getByRole('button', { name: 'Create empty project' }).click()

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
				await waitForHydration(page)
				// By role, not `getByText(...).first()`. PageHeader renders the page title
				// twice — once in the desktop topbar, once in the mobile header — and hides
				// the wrong one per breakpoint, so `.first()` lands on the hidden copy and
				// `toBeVisible` fails on mobile. Hidden elements are not in the
				// accessibility tree, so a role query only ever sees the live one.
				await expect(page.getByRole('heading', { name: projectName, level: 1 })).toBeVisible()

				// ── Delete project (via UI on /projects).
				await page.goto('/projects')
				await waitForHydration(page)
				// Scope to the card, not to `div.filter(hasText)` — `.first()` on that
				// resolves to the outermost div containing the name, which is a page
				// wrapper, and the click never became actionable. `.group` is the card root
				// in ProjectGridItem, and the button carries its own accessible name.
				const projectCard = page.locator('div.group').filter({ hasText: projectName }).first()
				await expect(projectCard).toBeVisible()
				await projectCard.getByRole('button', { name: 'Delete project' }).click()
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
