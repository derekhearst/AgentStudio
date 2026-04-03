import { expect, test } from '@playwright/test'
import { loginViaUi } from './helpers'

test('redirects unauthenticated user to login', async ({ page }) => {
	await page.goto('/chat')
	await expect(page).toHaveURL(/\/login/)
	await expect(page.getByRole('heading', { name: /sign in to drokbot/i })).toBeVisible()
})

test('keeps invalid login on login screen', async ({ page }) => {
	await page.goto('/login')
	await page.getByLabel('Password').fill('definitely-wrong-password')
	await page.getByRole('button', { name: /sign in/i }).click()
	await expect(page).toHaveURL(/\/login/)
	await expect(page.getByRole('heading', { name: /sign in to drokbot/i })).toBeVisible()
	await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
})

test('logs in through the UI and lands on the dashboard', async ({ page }) => {
	await loginViaUi(page)
	await page.goto('/')
	await expect(page.getByRole('heading', { name: /drokbot dashboard/i })).toBeVisible()
	await expect(page.locator('header').getByRole('link', { name: /settings/i })).toBeVisible()
})
