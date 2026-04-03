import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedAgent, uniquePrefix } from './helpers'

test('creates an agent through the UI and toggles its status', async ({ page }) => {
	const prefix = uniquePrefix('agent-create')
	const name = `${prefix} Agent`
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await page.goto('/agents/new')
		await page.waitForLoadState('networkidle')
		await page.getByLabel('Name').fill(name)
		await page.getByLabel('Role').fill(`${prefix} role`)
		await page.getByLabel('Model').fill('openai/gpt-4o-mini')
		await page.getByLabel('System prompt').fill(`${prefix} system prompt`)
		await page.getByRole('button', { name: /create agent/i }).click()

		await expect(page).toHaveURL(/\/agents\/[0-9a-f-]+$/)
		await expect(page.getByRole('heading', { name })).toBeVisible()

		await page.getByRole('button', { name: /^pause$/i }).click()
		const sql = getSql()
		await expect
			.poll(async () => {
				const pausedRows = await sql<{ status: string }[]>`select status from agents where name = ${name}`
				return pausedRows[0]?.status
			})
			.toBe('paused')

		await page.getByRole('button', { name: /^activate$/i }).click()
		await expect
			.poll(async () => {
				const activeRows = await sql<{ status: string }[]>`select status from agents where name = ${name}`
				return activeRows[0]?.status
			})
			.toBe('active')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('queues a task and delegates work from the agent detail page', async ({ page }) => {
	const prefix = uniquePrefix('agent-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const primary = await seedAgent(prefix, { name: `${prefix} Primary` })
		const secondary = await seedAgent(prefix, { name: `${prefix} Secondary` })

		await page.goto(`/agents/${primary.id}`)
		await page.getByPlaceholder('Task title').fill(`${prefix} Task`)
		await page.getByRole('textbox', { name: /^task details$/i }).fill(`${prefix} task details`)
		await page.getByRole('button', { name: /queue task/i }).click()
		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<{ count: string }[]>`
					select count(*)::text as count from agent_tasks where agent_id = ${primary.id} and title = ${`${prefix} Task`}
				`
				return Number(rows[0]?.count ?? 0)
			})
			.toBe(1)

		const delegateSection = page
			.locator('section')
			.filter({ hasText: /delegate task to another agent/i })
			.first()
		await delegateSection.getByRole('combobox').selectOption(secondary.id)
		await page.getByPlaceholder('Delegated task details').fill(`${prefix} delegated work`)
		await page.getByRole('button', { name: /delegate/i }).click()

		await expect
			.poll(async () => {
				const rows = await sql<{ count: string }[]>`
					select count(*)::text as count
					from agent_tasks
					where agent_id = ${secondary.id} and description = ${`${prefix} delegated work`}
				`
				return Number(rows[0]?.count ?? 0)
			})
			.toBe(1)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
