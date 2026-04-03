import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedAgent, seedTask, uniquePrefix } from './helpers'

test('moves a task between board columns and updates priority', async ({ page }) => {
	const prefix = uniquePrefix('tasks-board')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const agent = await seedAgent(prefix)
		const task = await seedTask(prefix, agent.id, { title: `${prefix} Board Task` })

		await page.goto('/tasks')
		const card = page.locator('article').filter({ hasText: task.title })
		await expect(card).toBeVisible()
		await card.getByRole('button', { name: /^p\+$/i }).click()
		const sql = getSql()
		await expect
			.poll(async () => {
				const priorityRows = await sql<{ priority: number }[]>`select priority from agent_tasks where id = ${task.id}`
				return Number(priorityRows[0]?.priority ?? 0)
			})
			.toBe(3)
		await card.getByRole('button', { name: /review/i }).click()
		await expect
			.poll(async () => {
				const statusRows = await sql<{ status: string }[]>`select status from agent_tasks where id = ${task.id}`
				return statusRows[0]?.status
			})
			.toBe('review')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('reassigns and completes a task from the detail page', async ({ page }) => {
	const prefix = uniquePrefix('task-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const primary = await seedAgent(prefix, { name: `${prefix} Primary` })
		const secondary = await seedAgent(prefix, { name: `${prefix} Secondary` })
		const task = await seedTask(prefix, primary.id, { title: `${prefix} Detail Task` })

		await page.goto(`/tasks/${task.id}`)
		await expect(page.getByRole('heading', { name: task.title })).toBeVisible()
		await page.locator('select').selectOption(secondary.id)
		await page.getByRole('button', { name: /reassign/i }).click()
		const sql = getSql()
		await expect
			.poll(async () => {
				const reassignedRows = await sql<
					{ agent_id: string; status: string }[]
				>`select agent_id, status from agent_tasks where id = ${task.id}`
				return reassignedRows[0]
			})
			.toMatchObject({ agent_id: secondary.id, status: 'pending' })

		await page.getByRole('button', { name: /^done$/i }).click()
		await expect
			.poll(async () => {
				const completedRows = await sql<{ status: string }[]>`select status from agent_tasks where id = ${task.id}`
				return completedRows[0]?.status
			})
			.toBe('completed')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
