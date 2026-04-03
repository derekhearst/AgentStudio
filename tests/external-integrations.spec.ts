import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedAgent, seedTask, uniquePrefix } from './helpers'

test('streams a mock assistant response from chat UI', async ({ page }) => {
	const prefix = uniquePrefix('ext-chat')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await page.goto('/chat')
		await page.waitForLoadState('networkidle')
		const newChatBtn = page.getByRole('button', { name: /\+ new chat/i })
		await newChatBtn.waitFor({ state: 'visible' })
		await newChatBtn.click()
		await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/, { timeout: 10000 })

		await page.getByPlaceholder('Message DrokBot...').fill(`${prefix} hello stream`)
		await page
			.locator('main')
			.getByRole('button', { name: /^send$/i })
			.first()
			.click()

		const conversationId = page.url().split('/').pop()
		expect(conversationId).toBeTruthy()
		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<{ content: string }[]>`
					select content from messages where conversation_id = ${conversationId ?? ''} and role = 'assistant' order by created_at desc limit 1
				`
				return rows[0]?.content ?? ''
			})
			.toContain('MOCK_STREAM:')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('executes an agent task to review state using mocked LLM/tool integrations', async ({ page }) => {
	const prefix = uniquePrefix('ext-agent')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const agent = await seedAgent(prefix, { status: 'active' })
		const task = await seedTask(prefix, agent.id, {
			title: `${prefix} Task`,
			description: `${prefix} task description`,
			status: 'pending',
		})

		await page.goto(`/agents/${agent.id}`)
		const taskCard = page.locator('article').filter({ hasText: task.title }).first()
		await expect(taskCard).toBeVisible()
		await taskCard.getByRole('button', { name: /^run$/i }).click()

		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<{ status: string }[]>`select status from agent_tasks where id = ${task.id}`
				return rows[0]?.status
			})
			.toBe('review')

		await page.goto(`/tasks/${task.id}`)
		await expect(page.getByText(/MOCK_RESPONSE:/i)).toBeVisible()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
