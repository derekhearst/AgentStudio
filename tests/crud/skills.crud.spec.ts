import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getSql,
	pollDb,
	seedSkill,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /skills + /skills/[id] CRUD lifecycle.
 *
 * Skills don't have a UI create form (creation happens via agent tools or
 * the agent identity editor), so we seed via SQL then drive the rest through
 * the UI: verify list visibility, edit description inline, toggle enabled,
 * add a file via the modal, expand it, edit the file, delete it, delete the
 * skill.
 */

test.describe('/skills — CRUD lifecycle', () => {
	test('seed → list visible → edit description → toggle enabled → add+edit+delete file → delete skill', async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-skills')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()

		const seed = await seedSkill(prefix, {
			description: `${prefix} initial description`,
			content: `${prefix} body content`,
			tags: ['test', prefix.toLowerCase()],
		})

		try {
			await withErrorCapture(page, async () => {
				// ── Read on /skills list
				await page.goto('/skills')
				await page.waitForLoadState('domcontentloaded')
				const listRow = page.locator('a').filter({ hasText: seed.name })
				await expect(listRow.first()).toBeVisible({ timeout: 8_000 })

				// ── Read on /skills/[id]
				await page.goto(`/skills/${seed.id}`)
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: seed.name }).first()).toBeVisible()

				// ── Update: edit description inline
				const newDescription = `${prefix} edited description`
				// The description button is inside <p> and clicking it switches to edit mode
				await page.getByRole('button', { name: `${prefix} initial description` }).click()
				const descriptionInput = page.locator('input.input-bordered.input-sm').first()
				await descriptionInput.fill(newDescription)
				await page.getByRole('button', { name: 'Save', exact: true }).first().click()
				await pollDb(
					() => sql<{ description: string }[]>`select description from skills where id = ${seed.id}`,
					(rows) => rows[0]?.description === newDescription,
					{ description: 'skill description updated' },
				)

				// ── Update: toggle disabled (one direction is sufficient — demonstrates the toggle path)
				const enabledToggle = page.locator('input[type="checkbox"].toggle').first()
				await enabledToggle.click()
				await pollDb(
					() => sql<{ enabled: boolean }[]>`select enabled from skills where id = ${seed.id}`,
					(rows) => rows[0]?.enabled === false,
					{ description: 'skill toggled off' },
				)
				// Toggle it back via SQL so the rest of the test sees an enabled skill
				// (the toggle re-render race in the page is captured separately by the
				// /settings/hooks failures page; not the focus of this CRUD test).
				await sql`update skills set enabled = true where id = ${seed.id}`
				await page.reload()
				await page.waitForLoadState('domcontentloaded')

				// ── Create: add a file via the modal
				const fileName = `${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-rules.md`
				const fileContent = `${prefix} file content with markdown`
				await page.getByRole('button', { name: '+ Add File' }).click()
				await page.getByPlaceholder('e.g. forms.md').fill(fileName)
				await page.getByPlaceholder('File content...').fill(fileContent)
				await page.getByRole('button', { name: /^Add File$/ }).click()
				const fileId = await pollDb(
					() => sql<{ id: string; content: string }[]>`
						select id, content from skill_files where skill_id = ${seed.id} and name = ${fileName}
					`,
					(rows) => rows.length === 1 && rows[0].content === fileContent,
					{ description: 'skill file inserted via UI' },
				).then((rows) => rows[0].id)

				// ── Update: edit the file content (inline)
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const editedContent = `${fileContent} (edited)`
				// Click the edit button next to the file
				const fileRow = page.locator('div.rounded-lg').filter({ hasText: fileName }).first()
				await fileRow.locator('button[title="Edit"]').click()
				const editTextarea = page.locator('textarea.textarea-bordered.font-mono').last()
				await editTextarea.fill(editedContent)
				// Find the Save button inside the inline editor
				await page.getByRole('button', { name: 'Save', exact: true }).first().click()
				await pollDb(
					() => sql<{ content: string }[]>`select content from skill_files where id = ${fileId}`,
					(rows) => rows[0]?.content === editedContent,
					{ description: 'skill file content updated' },
				)

				// ── Delete: file
				page.on('dialog', (d) => void d.accept())
				const fileRowAgain = page.locator('div.rounded-lg').filter({ hasText: fileName }).first()
				await fileRowAgain.locator('button[title="Delete"]').click()
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from skill_files where id = ${fileId}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'skill file deleted' },
				)

				// ── Delete: the entire skill
				await page.getByRole('button', { name: 'Delete skill' }).click()
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from skills where id = ${seed.id}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'skill deleted from DB' },
				)

				// ── Layout
				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
