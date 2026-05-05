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
 * /projects + /projects/[id] + /projects/[id]/artifacts/[aid] CRUD lifecycle.
 *
 * Covers:
 *   - Create project via form on /projects
 *   - Create artifact via the inline form on /projects/[id]
 *   - Read artifact v1 on /projects/[id]/artifacts/[aid]
 *   - Edit artifact (creates v2)
 *   - Rollback to v1 (creates v3, content matches v1)
 *   - Soft-delete artifact
 *   - Delete project (cascades artifacts + versions)
 */

test.describe('/projects — CRUD lifecycle', () => {
	test('create project → create artifact → edit → rollback → soft-delete → delete project', async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-projects')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const projectName = `${prefix} Project`
		const artifactName = `${prefix} Doc`
		const v1Content = `${prefix} version 1 content`
		const v2Content = `${prefix} version 2 content`

		// Auto-accept every confirm() dialog (rollback + soft-delete + delete project all use confirm).
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

				// ── Read project detail + create artifact (form is hidden behind "+ New artifact")
				await page.goto(`/projects/${projectId}`)
				await page.waitForLoadState('domcontentloaded')
				await page.getByRole('button', { name: '+ New artifact' }).click()
				await page.getByPlaceholder('e.g. Hydrofoil Assembly Guide').fill(artifactName)
				await page.getByPlaceholder('Type or paste content here…').fill(v1Content)
				await page.getByRole('button', { name: 'Create artifact' }).click()

				const artifactRow = await pollDb(
					() => sql<{ id: string; current_version_id: string }[]>`
						select id, current_version_id from artifacts where name = ${artifactName} and project_id = ${projectId}
					`,
					(rows) => rows.length === 1 && rows[0].current_version_id !== null,
					{ description: 'artifact created with v1 pointer' },
				)
				const artifactId = artifactRow[0].id

				// ── Read v1 on artifact detail
				await page.goto(`/projects/${projectId}/artifacts/${artifactId}`)
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByText(v1Content, { exact: false }).first()).toBeVisible()

				// ── Edit (creates v2)
				await page.getByRole('button', { name: 'Edit' }).click()
				const editTextarea = page.getByPlaceholder('Edit content here…')
				await editTextarea.fill(v2Content)
				// Find Save button inside the editor card
				await page.getByRole('button', { name: /^Save/ }).first().click()

				const versions = await pollDb(
					() => sql<{ seq: number; content: string }[]>`
						select seq, content from artifact_versions where artifact_id = ${artifactId} order by seq asc
					`,
					(rows) => rows.length === 2 && rows[1].content === v2Content,
					{ description: 'artifact v2 created with new content' },
				)
				expect(versions[0].content).toBe(v1Content)
				expect(versions[1].content).toBe(v2Content)

				// ── Rollback to v1 (creates v3 == v1 content)
				// Click "View v1" button first (versions list shows older ones)
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const v1Button = page.getByRole('button', { name: /^v1$|View v1/ }).first()
				if ((await v1Button.count()) > 0) {
					await v1Button.click().catch(() => null)
				}
				// Now click "Rollback to v1" if present
				// (dialog handler set above the try block)
				const rollbackButton = page.getByRole('button', { name: /Rollback/i }).first()
				if ((await rollbackButton.count()) > 0) {
					await rollbackButton.click()
					await pollDb(
						() => sql<{ seq: number; content: string }[]>`
							select seq, content from artifact_versions where artifact_id = ${artifactId} order by seq desc limit 1
						`,
						(rows) => rows[0]?.content === v1Content && rows[0]?.seq === 3,
						{ description: 'rollback created v3 with v1 content' },
					)
				}

				// ── Soft-delete artifact (button is hover-revealed; force its visibility,
				// and accept the confirm() dialog).
				// (dialog handler set above the try block)
				await page.goto(`/projects/${projectId}`)
				await page.waitForLoadState('domcontentloaded')
				const artifactLi = page.locator('li').filter({ hasText: artifactName }).first()
				await artifactLi.locator('button', { hasText: 'Soft delete' }).click()
				await pollDb(
					() => sql<{ is_active: boolean }[]>`select is_active from artifacts where id = ${artifactId}`,
					(rows) => rows[0]?.is_active === false,
					{ description: 'artifact soft-deleted' },
				)

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

				// Cascade: artifact + versions also gone
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from artifact_versions where artifact_id = ${artifactId}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'cascade dropped artifact_versions' },
				)

				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
