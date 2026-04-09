import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, seedNotification, uniquePrefix } from './helpers'

test('saves, persists, resets, and updates notification feed from settings', async ({ page }) => {
	const prefix = uniquePrefix('settings')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		await seedNotification(prefix, { title: `${prefix} Feed Notification`, body: `${prefix} feed body` })
		await page.goto('/settings')
		await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
		const preferencesSection = page
			.locator('section')
			.filter({ hasText: /general preferences/i })
			.first()

		await preferencesSection.getByLabel('Default Model').fill('openai/gpt-4o-mini')
		await preferencesSection.locator('select.select.select-bordered').first().selectOption('AgentStudio-night')
		await preferencesSection.getByLabel('Task completed alerts').uncheck()
		await page.getByRole('button', { name: /save settings/i }).click()
		await expect(page.getByText(/settings saved\./i)).toBeVisible()

		await page.reload()
		const reloadedPreferencesSection = page
			.locator('section')
			.filter({ hasText: /general preferences/i })
			.first()
		await expect(reloadedPreferencesSection.getByLabel('Default Model')).toHaveValue('openai/gpt-4o-mini')
		await expect(reloadedPreferencesSection.locator('select.select.select-bordered').first()).toHaveValue(
			'AgentStudio-night',
		)
		await expect(reloadedPreferencesSection.getByLabel('Task completed alerts')).not.toBeChecked()

		await page.getByPlaceholder('Title').fill(`${prefix} Notification`)
		await page.getByPlaceholder('Body').fill(`${prefix} Body`)
		await page.getByPlaceholder('URL').fill('/chat')
		await page
			.locator('section')
			.filter({ hasText: /send test notification/i })
			.getByRole('button', { name: /^send$/i })
			.click()
		await expect(page.getByText(/test notification sent\./i)).toBeVisible()
		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<{ count: string }[]>`
					select count(*)::text as count from notifications where title = ${`${prefix} Notification`}
				`
				return Number(rows[0]?.count ?? 0)
			})
			.toBe(1)
		const notificationCard = page.locator('article').filter({ hasText: `${prefix} Feed Notification` })
		await expect(notificationCard).toBeVisible()
		await notificationCard.getByRole('button', { name: /^read$/i }).click()
		await expect
			.poll(async () => {
				const rows = await sql<{ read: boolean }[]>`
					select read from notifications where title = ${`${prefix} Feed Notification`}
				`
				return rows[0]?.read ?? false
			})
			.toBe(true)

		await page.getByRole('button', { name: /reset defaults/i }).click()
		await expect(page.getByText(/settings reset to defaults\./i)).toBeVisible()
		await expect(reloadedPreferencesSection.getByLabel('Default Model')).toHaveValue('anthropic/claude-sonnet-4')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('responds to install prompt and mocked push subscription controls', async ({ page }) => {
	const prefix = uniquePrefix('push')
	await cleanupPrefixedRecords(prefix)
	await page.addInitScript(() => {
		let currentSubscription: {
			endpoint: string
			toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } }
			unsubscribe: () => Promise<boolean>
		} | null = null

		const buildSubscription = () => ({
			endpoint: 'https://push.example.test/subscription-e2e',
			toJSON: () => ({
				endpoint: 'https://push.example.test/subscription-e2e',
				keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
			}),
			unsubscribe: async () => {
				currentSubscription = null
				return true
			},
		})

		Object.defineProperty(window, 'Notification', {
			configurable: true,
			value: {
				requestPermission: async () => 'granted',
			},
		})

		Object.defineProperty(window, 'PushManager', {
			configurable: true,
			value: class PushManager {},
		})

		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: {
				register: async () => ({}),
				ready: Promise.resolve({
					pushManager: {
						getSubscription: async () => currentSubscription,
						subscribe: async () => {
							currentSubscription = buildSubscription()
							return currentSubscription
						},
					},
				}),
			},
		})
	})
	await authenticateContext(page.context())

	try {
		await page.goto('/settings')
		await expect(page.getByRole('button', { name: /install app/i })).toBeVisible()
		await page.evaluate(() => {
			const installEvent = new CustomEvent('beforeinstallprompt') as unknown as Event & {
				prompt: () => Promise<void>
				userChoice: Promise<{ outcome: string; platform: string }>
			}
			Object.defineProperty(installEvent, 'prompt', { value: async () => {} })
			Object.defineProperty(installEvent, 'userChoice', {
				value: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
			})
			window.dispatchEvent(installEvent)
		})
		await page.waitForTimeout(100)

		const installButton = page.getByRole('button', { name: /install app/i })
		await expect(installButton).toBeEnabled()
		await installButton.click()
		await expect(installButton).toBeDisabled()

		await page.getByRole('button', { name: /enable push/i }).click()
		await expect(page.getByText(/push notifications enabled\./i)).toBeVisible()

		await page.getByRole('button', { name: /disable push/i }).click()
		await expect(page.getByText(/push notifications disabled\./i)).toBeVisible()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
