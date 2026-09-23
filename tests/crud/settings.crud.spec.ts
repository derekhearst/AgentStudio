import { expect, test } from '@playwright/test'
import {
	acquireGlobalStateLock,
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
 *
 * Saving a daily limit creates an enabled global block limit in `budget_limits`, which the
 * budget gate checks before every run. So this holds the same `budget-state` then
 * `settings-state` locks as the other budget and settings specs, and removes any limit rows
 * it caused before putting the settings back — a stray one would block the owner's chats.
 */

type BudgetConfig = {
	dailyLimit: number | null
	monthlyLimit: number | null
	limitIds?: Record<string, string | null>
}

test.describe('/settings — CRUD lifecycle', () => {
	test('read → update budget + memory → reset', async ({ page, context }) => {
		const prefix = uniquePrefix('crud-settings')
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveAdminUserId()
		const releases = [await acquireGlobalStateLock('budget-state'), await acquireGlobalStateLock('settings-state')]

		// Snapshot the current settings so the reset assertion can compare back to defaults
		// regardless of what the admin had configured before the test ran.
		const [snapshot] = await sql<
			{
				default_model: string
				transcription_model: string
				budget_config: BudgetConfig | null
				memory_config: { topK: number; enabled: boolean } | null
				tts_model: string
				tts_voice: string
			}[]
		>`
			select default_model, transcription_model, budget_config, memory_config, tts_model, tts_voice from app_settings
			where user_id = ${userId} order by created_at asc limit 1
		`

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

				// A non-default transcription model, set behind the page's back. Reset used to
				// name the fields it reset one by one and skipped this one.
				const sentinelTranscriptionModel = `${prefix}/audio-model`
				// DEFAULT_SETTINGS.transcriptionModel. Written out rather than imported: the
				// defaults live in settings.server.ts, and importing that module from this worker
				// would open a database pool and run the bootstrap.
				const defaultTranscriptionModel = 'google/gemini-2.5-flash'
				await sql`
					update app_settings set transcription_model = ${sentinelTranscriptionModel}
					where user_id = ${userId}
				`

				// ── Reset: click Reset
				await page.getByRole('button', { name: 'Reset' }).click()
				const [reset] = await pollDb(
					() => sql<
						{ budget_config: BudgetConfig | null; transcription_model: string; tts_model: string; tts_voice: string }[]
					>`
						select budget_config, transcription_model, tts_model, tts_voice from app_settings
						where user_id = ${userId} order by created_at asc limit 1
					`,
					(rows) =>
						rows[0]?.budget_config?.dailyLimit === null &&
						rows[0]?.budget_config?.monthlyLimit === null &&
						rows[0]?.transcription_model === defaultTranscriptionModel &&
						rows[0]?.tts_model === DEFAULT_TTS_MODEL &&
						rows[0]?.tts_voice === DEFAULT_TTS_VOICE,
					{ description: 'reset cleared the budget limits and restored the transcription and read-aloud defaults' },
				)

				// The limit the save made enforceable is switched off by the reset, not left blocking.
				const dailyLimitId = reset.budget_config?.limitIds?.day
				expect(dailyLimitId, 'reset keeps the id of the daily limit row it switches off').toBeTruthy()
				await pollDb(
					() => sql<{ enabled: boolean }[]>`select enabled from budget_limits where id = ${dailyLimitId!}`,
					(rows) => rows[0]?.enabled === false,
					{ description: 'reset switched off the daily limit row the save created' },
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
			try {
				// Best-effort restore of pre-test settings via direct SQL (don't poll the UI for this).
				// First the limit rows the save created: restoring the snapshot drops their ids, and
				// nothing else would ever switch them off. A row the snapshot already named is kept;
				// the budget gate brings it back to the restored amount on its next check.
				const [current] = await sql<{ budget_config: BudgetConfig | null }[]>`
					select budget_config from app_settings where user_id = ${userId} order by created_at asc limit 1
				`
				const before = Object.values(snapshot?.budget_config?.limitIds ?? {})
				const created = Object.values(current?.budget_config?.limitIds ?? {}).filter(
					(id): id is string => typeof id === 'string' && !before.includes(id),
				)
				if (created.length) await sql`delete from budget_limits where id in ${sql(created)}`
				if (snapshot) {
					await sql`
						update app_settings
						set default_model = ${snapshot.default_model},
						    transcription_model = ${snapshot.transcription_model},
						    budget_config = ${sql.json(snapshot.budget_config ?? {})},
						    memory_config = ${sql.json(snapshot.memory_config ?? {})},
						    tts_model = ${snapshot.tts_model},
						    tts_voice = ${snapshot.tts_voice}
						where user_id = ${userId}
					`
				}
			} finally {
				for (const release of releases.reverse()) await release()
			}
		}
	})
})
