import { expect, test } from '@playwright/test'
import { answerConfirmDialog, authenticateContext, cleanupExtendedPrefix, expectNoHorizontalOverflow, getSql, pollDb, seedSkill, uniquePrefix, withErrorCapture } from '../helpers'

/**
 * /skills + /skills/[id] CRUD lifecycle.
 *
 * Skills don't have a UI create form (creation happens via agent tools or
 * the agent identity editor), so we seed via SQL then drive the rest through
 * the UI: verify list visibility, edit description inline, toggle enabled,
 * add a file via the modal, expand it, edit the file, delete it, delete the
 * skill.
 *
 * Every step asserts the page as well as the database, and never reloads to get
 * there. This spec used to reload after adding a file and reset the toggle through
 * SQL, which hid that the page re-read a cached query after each edit: a saved
 * description snapped back, a disabled skill still showed as enabled, and a new file
 * did not appear.
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
				await expect(page.getByRole('button', { name: newDescription })).toBeVisible()
				await expect(page.getByRole('button', { name: `${prefix} initial description` })).toHaveCount(0)

				// ── Update: toggle disabled, then back on — both through the switch
				const enabledToggle = page.locator('input[type="checkbox"].toggle').first()
				const disabledChip = page.getByText('disabled', { exact: true }).filter({ visible: true })
				await enabledToggle.click()
				await pollDb(
					() => sql<{ enabled: boolean }[]>`select enabled from skills where id = ${seed.id}`,
					(rows) => rows[0]?.enabled === false,
					{ description: 'skill toggled off' },
				)
				await expect(disabledChip).toBeVisible()
				await expect(enabledToggle).not.toBeChecked()

				await enabledToggle.click()
				await pollDb(
					() => sql<{ enabled: boolean }[]>`select enabled from skills where id = ${seed.id}`,
					(rows) => rows[0]?.enabled === true,
					{ description: 'skill toggled back on' },
				)
				await expect(disabledChip).toHaveCount(0)
				await expect(enabledToggle).toBeChecked()

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
				await expect(page.getByRole('heading', { name: 'Resource files (1)' })).toBeVisible()
				await expect(page.getByText(fileName, { exact: true })).toBeVisible()

				// ── Update: edit the file content (inline)
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
				// Expanded, the file shows what was just saved — not the content it was added with.
				await page.getByText(fileName, { exact: true }).click()
				await expect(page.getByText(editedContent, { exact: true })).toBeVisible()

				// ── Delete: file
				const fileRowAgain = page.locator('div.rounded-lg').filter({ hasText: fileName }).first()
				await fileRowAgain.locator('button[title="Delete"]').click()
				await answerConfirmDialog(page, 'Delete')
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from skill_files where id = ${fileId}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'skill file deleted' },
				)
				await expect(page.getByRole('heading', { name: 'Resource files (0)' })).toBeVisible()
				await expect(page.getByText(fileName, { exact: true })).toHaveCount(0)

				// ── Delete: the entire skill
				await page.getByRole('button', { name: 'Delete skill' }).click()
				await answerConfirmDialog(page, 'Delete')
				await pollDb(
					() => sql<{ count: number }[]>`select count(*)::int as count from skills where id = ${seed.id}`,
					(rows) => rows[0]?.count === 0,
					{ description: 'skill deleted from DB' },
				)
				// Deleting sends you back to the list, which must not still offer the skill.
				await expect(page).toHaveURL(/\/skills$/)
				await expect(page.locator('a').filter({ hasText: seed.name })).toHaveCount(0)

				// ── Layout
				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
