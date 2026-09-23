import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	expectNoHorizontalOverflow,
	getActiveAdminUserId,
	getSql,
	pollDb,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../../src/lib/speech/speech'

/**
 * /settings — read defaults, update budget + memory + read-aloud voice, reset.
 *
 * Asserts each mutation persists to the `app_settings` table for the active admin
 * user AND that an `audit_events` row is written (settings.updated / settings.reset)
 * via the existing governance wrappers.
 */

test.describe('/settings — CRUD lifecycle', () => {
	test('read → update budget + memory → reset', async ({ page, context }) => {
		const prefix = uniquePrefix('crud-settings')
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveAdminUserId()

		// Snapshot the current settings so the reset assertion can compare back to defaults
		// regardless of what the admin had configured before the test ran.
		const [snapshot] = await sql<
			{
				default_model: string
				budget_config: { dailyLimit: number | null; monthlyLimit: number | null } | null
				memory_config: { topK: number; enabled: boolean } | null
				tts_model: string
				tts_voice: string
			}[]
		>`select default_model, budget_config, memory_config, tts_model, tts_voice from app_settings where user_id = ${userId}`

		try {
			await withErrorCapture(page, async () => {
				// ── Read
				await page.goto('/settings')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: 'Settings', exact: true }).first()).toBeVisible()

				// ── Update: change daily budget cap to a unique sentinel value.
				// The Daily limit / Monthly limit inputs are the only number inputs with the
				// "No limit" placeholder, so target by placeholder.
				const sentinelDaily = 12.34
				const limitInputs = page.locator('input[type="number"][placeholder="No limit"]')
				await expect(limitInputs.first()).toBeVisible()
				await limitInputs.nth(0).fill(String(sentinelDaily))
				await limitInputs.nth(0).blur()

				// Update memory topK to a sentinel value via the unique min=1 max=20 attrs.
				const memoryTopK = 7
				const topKInput = page.locator('input[type="number"][min="1"][max="20"]').first()
				await topKInput.fill(String(memoryTopK))
				await topKInput.blur()

				// #27 — pick a different read-aloud voice. A <select> of the model's voices when
				// OpenRouter's speech catalogue answered, a text field when it did not. Settle first:
				// the field changes from one to the other when the catalogue arrives.
				await page.waitForLoadState('networkidle')
				const voiceField = page.getByLabel('Read-aloud voice')
				await expect(voiceField).toBeVisible()
				let sentinelVoice = 'af_bella'
				if ((await voiceField.evaluate((el) => el.tagName)) === 'SELECT') {
					const values = await voiceField.locator('option').evaluateAll((options) =>
						options.map((option) => (option as HTMLOptionElement).value),
					)
					const current = await voiceField.inputValue()
					sentinelVoice = values.find((value) => value && value !== current) ?? sentinelVoice
					await voiceField.selectOption(sentinelVoice)
				} else {
					await voiceField.fill(sentinelVoice)
				}

				// Click save
				await page.getByRole('button', { name: /^Save$/, exact: true }).click()

				// DB invariant: budget + memory + voice persisted
				await pollDb(
					() => sql<{ budget_config: { dailyLimit: number | null }; memory_config: { topK: number }; tts_voice: string }[]>`
						select budget_config, memory_config, tts_voice from app_settings where user_id = ${userId}
					`,
					(rows) =>
						rows[0]?.budget_config?.dailyLimit === sentinelDaily &&
						rows[0]?.memory_config?.topK === memoryTopK &&
						rows[0]?.tts_voice === sentinelVoice,
					{ description: 'settings update persists daily limit + memory topK + read-aloud voice' },
				)

				// Audit invariant: settings.updated row written
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from audit_events
						where action = 'settings.updated'::audit_action
						  and target_id = ${userId}
						  and created_at >= now() - interval '1 minute'
					`,
					(rows) => (rows[0]?.count ?? 0) >= 1,
					{ description: 'audit_events row for settings.updated' },
				)

				// ── Reset: click Reset
				await page.getByRole('button', { name: 'Reset' }).click()
				await pollDb(
					() => sql<{ budget_config: { dailyLimit: number | null } | null; tts_model: string; tts_voice: string }[]>`
						select budget_config, tts_model, tts_voice from app_settings where user_id = ${userId}
					`,
					(rows) =>
						rows[0]?.budget_config?.dailyLimit !== sentinelDaily &&
						rows[0]?.tts_model === DEFAULT_TTS_MODEL &&
						rows[0]?.tts_voice === DEFAULT_TTS_VOICE,
					{ description: 'reset wiped the sentinel daily limit and restored the read-aloud defaults' },
				)

				// Audit invariant: settings.reset row written
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from audit_events
						where action = 'settings.reset'::audit_action
						  and target_id = ${userId}
						  and created_at >= now() - interval '1 minute'
					`,
					(rows) => (rows[0]?.count ?? 0) >= 1,
					{ description: 'audit_events row for settings.reset' },
				)

				// ── Layout check
				await expectNoHorizontalOverflow(page, {
					ignoreSelectors: ['pre', 'pre *', '.overflow-x-auto', '.overflow-x-auto *'],
				})
			})
		} finally {
			// Best-effort restore of pre-test settings via direct SQL (don't poll the UI for this).
			if (snapshot) {
				await sql`
					update app_settings
					set default_model = ${snapshot.default_model},
					    budget_config = ${sql.json(snapshot.budget_config ?? {})},
					    memory_config = ${sql.json(snapshot.memory_config ?? {})},
					    tts_model = ${snapshot.tts_model},
					    tts_voice = ${snapshot.tts_voice}
					where user_id = ${userId}
				`
			}
			// Suppress unused-var warning
			void prefix
		}
	})
})
