import { expect, test } from '@playwright/test'
import {
	acquireGlobalStateLock,
	authenticateContext,
	cleanupPrefixedRecords,
	getSql,
	seedNotification,
	uniquePrefix,
} from './helpers'

test('saves, persists, resets, and updates notification feed from settings', async ({ page }) => {
	const prefix = uniquePrefix('settings')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	// Saving and resetting rewrite the one shared settings row, which notifications.prefs
	// sets and restores under the same lock.
	const release = await acquireGlobalStateLock('settings-state')

	try {
		await seedNotification(prefix, { title: `${prefix} Feed Notification`, body: `${prefix} feed body` })
		await page.goto('/settings')
		await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()

		// The page was rebuilt from one "General preferences" <section> into per-topic panels.
		// Two of the old assertions have no equivalent and are gone rather than faked: the
		// theme picker (there is one theme now, applied unconditionally) and filling Default
		// Model as text (it is a ModelSelector combobox — its own concern, not this test's).
		// Do not assert the incoming value: settings are a single shared row, so whatever a
		// previous run left behind is what this one starts from. Drive it to a known state.
		const taskCompleted = page.getByLabel('Task completed', { exact: true })
		await taskCompleted.uncheck()
		await page.getByRole('button', { name: 'Save', exact: true }).click()
		await expect(page.getByText('Settings saved.').filter({ visible: true }).first()).toBeVisible()

		await page.reload()
		await expect(page.getByLabel('Task completed', { exact: true })).not.toBeChecked()

		await page.getByPlaceholder('Title').fill(`${prefix} Notification`)
		await page.getByPlaceholder('Body').fill(`${prefix} Body`)
		await page.getByRole('button', { name: /^send$/i }).click()
		await expect(page.getByText(/test notification sent\./i).filter({ visible: true }).first()).toBeVisible()
		const sql = getSql()
		await expect
			.poll(async () => {
				const rows = await sql<{ count: string }[]>`
					select count(*)::text as count from notifications where title = ${`${prefix} Notification`}
				`
				return Number(rows[0]?.count ?? 0)
			})
			.toBe(1)

		// Feed rows are plain divs now. Match the innermost div that holds both the title and
		// the row's own button — `.last()` on the title alone lands on the text wrapper,
		// which does not contain the button.
		const notificationCard = page
			.locator('div')
			.filter({ hasText: `${prefix} Feed Notification` })
			.filter({ has: page.getByRole('button', { name: /^(read|unread)$/i }) })
			.last()
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

		await page.getByRole('button', { name: 'Reset', exact: true }).click()
		await expect(page.getByText('Settings reset to defaults.').filter({ visible: true }).first()).toBeVisible()
		await expect(page.getByLabel('Task completed', { exact: true })).toBeChecked()
	} finally {
		await release()
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
				// The app enumerates registrations on load to clear stale workers; without this
				// the mock throws "getRegistrations is not a function" during hydration.
				getRegistrations: async () => [],
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

	// The mocked endpoint is a fixed string, not prefixed, so `cleanupPrefixedRecords`
	// cannot see it. Left behind, it makes the next run start with push already enabled
	// and the Enable button absent.
	const sql = getSql()
	const clearTestSubscription = () =>
		sql`delete from push_subscriptions where endpoint = ${'https://push.example.test/subscription-e2e'}`
	await clearTestSubscription()

	try {
		await page.goto('/settings')
		// The button keeps one accessible name and expresses availability through `disabled`;
		// only its visible text flips between "Install" and "Installed".
		const installBtn = page.getByRole('button', { name: 'Install app' })
		await expect(installBtn).toBeVisible()
		await expect(installBtn).toBeDisabled()

		// Wait for hydration before dispatching `beforeinstallprompt`. The button is in the
		// SSR HTML, so it is visible well before onMount attaches the listener — dispatching
		// on visibility alone races the handler and the event is simply lost. The panels
		// below only render once the client has loaded settings, so they are the honest
		// signal that the page is live.
		await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
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

		const installButton = installBtn
		await expect(installButton).toBeEnabled()
		await installButton.click()
		await expect(installButton).toBeDisabled()

		await page.getByRole('button', { name: /enable push/i }).click()
		await expect(page.getByText(/push notifications enabled\./i).filter({ visible: true }).first()).toBeVisible()

		await page.getByRole('button', { name: /disable push/i }).click()
		await expect(page.getByText(/push notifications disabled\./i).filter({ visible: true }).first()).toBeVisible()
	} finally {
		await clearTestSubscription()
		await cleanupPrefixedRecords(prefix)
	}
})
