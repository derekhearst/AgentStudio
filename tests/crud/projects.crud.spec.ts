import { expect, test } from '@playwright/test'
import { answerConfirmDialog, authenticateContext, cleanupExtendedPrefix, expectNoHorizontalOverflow, getSql, pollDb, uniquePrefix, waitForHydration, withErrorCapture } from '../helpers'

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
 *
 * The list is checked straight after each mutation, without navigating: /projects
 * re-read a cached query after create and delete, so the new project did not appear and
 * the deleted one stayed until a full reload.
 */

test.describe('/projects — CRUD lifecycle', () => {
	test('create project → open detail → delete project', async ({ page, context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-projects')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const projectName = `${prefix} Project`

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

				// The list shows it straight away.
				const newCard = page.locator('div.group').filter({ hasText: projectName })
				await expect(newCard.first()).toBeVisible({ timeout: 10_000 })

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
				await answerConfirmDialog(page, 'Delete')
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from projects where id = ${projectId}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'project deleted from DB' },
				)
				await expect(page.locator('div.group').filter({ hasText: projectName })).toHaveCount(0)

				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})

	/*
	 * The modal's reset effect used to read the tab it had just written, so clicking any tab
	 * re-ran it: the tab snapped back to "Empty" and the typed name was wiped. Only an empty
	 * project could ever be created from the page. This drives the tabs and then creates a
	 * local-repo project, which was impossible before.
	 */
	test('switching tabs keeps the chosen tab and what was typed; a local project can be created', async ({ page, context }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('crud-projects-tabs')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const projectName = `${prefix} Local`

		try {
			await withErrorCapture(page, async () => {
				await page.goto('/projects')
				await waitForHydration(page)
				await page.getByRole('button', { name: '+ New project' }).click()
				const nameInput = page.getByPlaceholder('e.g. Efoil Rebuild')
				await nameInput.fill(projectName)

				await page.getByRole('button', { name: 'From URL', exact: true }).click()
				await expect(page.getByPlaceholder('https://github.com/owner/repo · any clone URL')).toBeVisible()
				await expect(page.getByRole('button', { name: 'Create empty project' })).toHaveCount(0)
				await expect(nameInput).toHaveValue(projectName)

				await page.getByRole('button', { name: 'Local repo', exact: true }).click()
				const createLocal = page.getByRole('button', { name: 'Create local project' })
				await expect(createLocal).toBeVisible()
				await expect(nameInput).toHaveValue(projectName)

				await createLocal.click()
				const created = await pollDb(
					() => sql<{ id: string; repo_kind: string }[]>`
						select id, repo_kind::text as repo_kind from projects where name = ${projectName}
					`,
					(rows) => rows.length === 1,
					{ description: 'local project created via UI', timeoutMs: 30_000 },
				)
				expect(created[0].repo_kind).toBe('local')

				// Delete through the page so the project's directory goes with it.
				await page.goto('/projects')
				await waitForHydration(page)
				const projectCard = page.locator('div.group').filter({ hasText: projectName }).first()
				await projectCard.getByRole('button', { name: 'Delete project' }).click()
				await answerConfirmDialog(page, 'Delete')
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from projects where id = ${created[0].id}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'local project deleted from DB' },
				)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
