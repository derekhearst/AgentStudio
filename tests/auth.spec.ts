import { expect, test } from '@playwright/test'
import { loginViaUi } from './helpers'

test('redirects unauthenticated user to login', async ({ page }) => {
	await page.goto('/chat')
	await expect(page).toHaveURL(/\/login/)
	await expect(page.getByRole('heading', { name: /sign in to AgentStudio/i })).toBeVisible()
})

test('keeps invalid login on login screen', async ({ page }) => {
	await page.goto('/login')
	await page.getByLabel('Password').fill('definitely-wrong-password')
	await page.getByRole('button', { name: /sign in/i }).click()
	await expect(page).toHaveURL(/\/login/)
	await expect(page.getByRole('heading', { name: /sign in to AgentStudio/i })).toBeVisible()
	await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
})

test('logs in through the UI and lands on the chat home', async ({ page }) => {
	await loginViaUi(page)
	await page.goto('/')
	// Home is the new-chat console, not the old dashboard. The composer is the honest
	// signal that the page is up and hydrated; the greeting heading is not usable here
	// because mobile renders a second h1 in the topbar, and its text depends on the time
	// of day and the account name.
	await expect(page).toHaveURL(/\/$/)
	await expect(page.getByPlaceholder('Start a new conversation...')).toBeVisible()
})
