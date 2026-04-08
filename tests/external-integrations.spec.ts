import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	expectRealAssistantReply,
	getSql,
	seedAgent,
	seedConversation,
	seedTask,
	uniquePrefix,
} from './helpers'

test('streams and persists a real assistant response from chat UI', async ({ page }) => {
	const prefix = uniquePrefix('ext-chat')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const conversation = await seedConversation(prefix)
		await page.goto(`/chat/${conversation.id}`)
		await page.waitForLoadState('networkidle')

		await page.getByPlaceholder('Message AgentStudio...').fill(`${prefix} hello stream`)
		await page
			.getByRole('button', { name: /send message/i })
			.first()
			.click()

		const content = await expectRealAssistantReply(conversation.id)
		expect(content.length).toBeGreaterThan(8)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('executes an agent task to review state using real LLM/tool integrations', async ({ page }) => {
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
			.poll(
				async () => {
					const rows = await sql<{ status: string }[]>`select status from agent_tasks where id = ${task.id}`
					return rows[0]?.status
				},
				{ timeout: 120000 },
			)
			.toMatch(/review|completed|failed/)

		await page.goto(`/tasks/${task.id}`)
		await expect(page.getByRole('heading', { name: /execution result/i })).toBeVisible()
		await expect
			.poll(async () => {
				const rows = await sql<{ result: unknown }[]>`select result from agent_tasks where id = ${task.id}`
				return JSON.stringify(rows[0]?.result ?? {})
			})
			.toContain('summary')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
