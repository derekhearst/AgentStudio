import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	seedAgent,
	seedConversation,
	seedMemory,
	seedNotification,
	seedTask,
	uniquePrefix,
} from './helpers'

test('dashboard shows live seeded activity and workspace navigation', async ({ page }) => {
	const prefix = uniquePrefix('dashboard')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const agent = await seedAgent(prefix, { name: `${prefix} Agent` })
		const task = await seedTask(prefix, agent.id, { title: `${prefix} Dashboard Task`, status: 'review' })
		const conversation = await seedConversation(prefix, { title: `${prefix} Dashboard Conversation` })
		await seedMemory(prefix, { content: `${prefix} dashboard memory` })
		await seedNotification(prefix, { title: `${prefix} Dashboard Notification` })

		await page.goto('/')
		await expect(page.getByRole('heading', { name: /drokbot dashboard/i })).toBeVisible()
		await expect(page.getByText(conversation.title)).toBeVisible()
		await expect(page.getByRole('link', { name: task.title })).toBeVisible()
		await expect(page.getByText(/review:/i)).toBeVisible()

		await page.getByRole('link', { name: /^chat$/i }).click()
		await expect(page).toHaveURL(/\/chat$/)

		await page.getByRole('link', { name: /^dashboard$/i }).click()
		await expect(page).toHaveURL(/\/$/)

		await page
			.locator('header')
			.getByRole('link', { name: /^settings$/i })
			.click()
		await expect(page).toHaveURL(/\/settings$/)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
