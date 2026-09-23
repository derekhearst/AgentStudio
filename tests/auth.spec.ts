import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, loginViaUi, readEnvVar } from './helpers'

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

test('signing in through the form hands the shell a signed-in session without a reload', async ({ page }) => {
	// The root layout publishes `{ user, authenticated }` from `locals`, and SvelteKit does
	// not re-run a load that depends on nothing it tracks. /login is rendered for an anonymous
	// visitor, so after `goto('/')` the shell kept `authenticated: false`: no credit balance
	// and no `page.data.user` until a manual reload. The visible symptom is that the shell's
	// credits query — gated on `authenticated` — is never sent.
	//
	// This needs the real password. CI seeds the owner from AUTH_PASSWORD, so it runs there;
	// a developer database whose owner chose another password skips rather than fails.
	const password = readEnvVar('AUTH_PASSWORD')
	const userId = await getActiveUserId()
	const sql = getSql()
	const [owner] = await sql<{ password_hash: string | null }[]>`select password_hash from users where id = ${userId}`
	const { verify } = await import('@node-rs/argon2')
	const known = !!password && !!owner?.password_hash && (await verify(owner.password_hash, password))
	test.skip(!known, 'AUTH_PASSWORD is not the owner password on this database')

	await page.goto('/login')
	const creditsRequested = page.waitForRequest((request) => request.url().includes('/getCredits'), { timeout: 15_000 })
	await page.getByLabel('Password').fill(password!)
	await page.getByRole('button', { name: /sign in/i }).click()
	await expect(page).toHaveURL(/\/$/)
	await creditsRequested
})
