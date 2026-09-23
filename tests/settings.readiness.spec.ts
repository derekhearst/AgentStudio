import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'
import { buildReadinessRows, type ReadinessFacts } from '../src/lib/settings/readiness'

/**
 * Settings > System — the read-only checklist of deploy-time configuration (#2).
 *
 * First run collects only the owner account; the model credential, workspace, gateway and
 * integrations stay environment settings. This panel is how an operator sees whether they
 * are in place — so it must be right about "missing", and it must never hand a configured
 * secret to the browser.
 */

const SECRETS = {
	DATABASE_URL: 'postgresql://user:db-secret-value@host/db',
	ANTHROPIC_API_KEY: 'sk-ant-secret-value',
	LLM_GATEWAY_URL: 'https://gateway.internal/secret-path',
	LLM_GATEWAY_TOKEN: 'gateway-secret-value',
	OPENROUTER_API_KEY: 'sk-or-secret-value',
	SEARXNG_URL: 'http://searx.internal:8070',
	GITHUB_OAUTH_CLIENT_ID: 'gh-client-id-value',
	GITHUB_OAUTH_CLIENT_SECRET: 'gh-client-secret-value',
	APP_ENCRYPTION_KEY: 'encryption-secret-value',
	GITHUB_WEBHOOK_SECRET: 'webhook-secret-value',
	VAPID_PUBLIC_KEY: 'vapid-public-value',
	VAPID_PRIVATE_KEY: 'vapid-private-value',
	CRON_SECRET: 'cron-secret-value',
}

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
	return {
		env: {},
		migrations: { databaseReachable: true, migrationsInSync: true, bundled: 60, applied: 60 },
		claudeCredentialFile: null,
		sandbox: { root: '/workspace', writable: true },
		shellSandbox: true,
		...overrides,
	}
}

test.describe('settings/readiness — the rules', () => {
	test('a fully configured instance is all green, and no value reaches the rows', () => {
		const rows = buildReadinessRows(facts({ env: SECRETS }))
		expect(rows.filter((row) => !row.ok).map((row) => row.id)).toEqual([])
		const serialized = JSON.stringify(rows)
		for (const [name, value] of Object.entries(SECRETS)) {
			expect(serialized, `${name}'s value must not be sent to the browser`).not.toContain(value)
		}
	})

	test('a bare instance names what is missing, and which of it is required', () => {
		const rows = buildReadinessRows(
			facts({
				migrations: { databaseReachable: true, migrationsInSync: false, bundled: 60, applied: 59 },
				sandbox: { root: '/workspace', writable: false },
				shellSandbox: false,
			}),
		)
		const byId = new Map(rows.map((row) => [row.id, row]))
		const missingRequired = rows.filter((row) => row.required && !row.ok).map((row) => row.id)
		expect(missingRequired.sort()).toEqual(['claude', 'database', 'sandbox'])
		expect(byId.get('database')!.detail).toContain('59 of 60')
		expect(byId.get('claude')!.detail).toMatch(/claude login/)
		for (const id of ['gateway', 'openrouter', 'search', 'github', 'github-webhooks', 'push', 'cron', 'shell-sandbox']) {
			expect(byId.get(id), id).toMatchObject({ required: false, ok: false })
		}
		// Every row that can be fixed with configuration names the variable to set.
		expect(byId.get('sandbox')!.envVars).toEqual(['SANDBOX_WORKSPACE'])
		expect(byId.get('gateway')!.envVars).toEqual(['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN'])
	})

	test('the Claude row accepts a CLI login on disk or a key in the environment', () => {
		const find = (f: ReadinessFacts) => buildReadinessRows(f).find((row) => row.id === 'claude')!
		expect(find(facts({ claudeCredentialFile: '/data/.claude/.credentials.json' })).ok).toBe(true)
		expect(find(facts({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } })).ok).toBe(true)
		expect(find(facts({ env: { ANTHROPIC_API_KEY: '   ' } })).ok, 'blank is not set').toBe(false)
	})

	test('a half-configured integration counts as off', () => {
		const rows = buildReadinessRows(facts({ env: { GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret' } }))
		expect(rows.find((row) => row.id === 'github')!.ok, 'APP_ENCRYPTION_KEY is missing').toBe(false)
	})
})

test.describe('settings/readiness — the panel', () => {
	test('Settings shows the System checklist to the owner', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/settings')
		const list = page.getByRole('list', { name: 'System checklist' })
		await expect(list).toBeVisible({ timeout: 20_000 })
		// The suite's own database is reachable and migrated, so this row is green here.
		await expect(list.locator('[data-readiness="database"]')).toHaveAttribute('data-ok', 'true')
		for (const id of ['claude', 'sandbox', 'gateway', 'github', 'push']) {
			await expect(list.locator(`[data-readiness="${id}"]`), id).toHaveCount(1)
		}
	})

	test('a failed load shows the message the server chose', () => {
		// A remote call rejects with an HttpError, which is not an Error, so the old
		// `err instanceof Error ? err.message : String(err)` printed the error object itself.
		const panel = readFileSync(join(process.cwd(), 'src/lib/settings/panels/SettingsSystemPanel.svelte'), 'utf8')
		expect(panel).toContain('loadError = remoteErrorMessage(err, ')
		expect(panel).not.toContain('err instanceof Error')
	})
})
