import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'
import { ENGINE_EXCLUDED_TOOLS, HOST_OWNED_TOOLS } from '../src/lib/engine/builtin-tools'
import { ASK_USER_QUESTION_TOOL } from '../src/lib/engine/ask-user-question'
import { allToolNames } from '../src/lib/tools/tool-schemas'
import { BUILTIN_TOOLS, MANDATORY_APPROVAL_TOOLS } from '../src/lib/tools/tools'

/**
 * Settings > Tool Approval lists what a chat run can actually call, and every entry works.
 *
 * The panel used to promise things the chat engine never did (audit finding 117):
 *
 *   - a "Programmatic tool calling" toggle that exposed `run_code`, which the engine never
 *     registered and which could not run there (#69 retired the tool);
 *   - an "Always loaded" tier (web_search, ask_user, run_code, search_tools) and a
 *     "Searchable" tier "loaded only after the model invokes search_tools" — deferred
 *     loading that only the old loop ever had (#8 deleted it);
 *   - and the "Always loaded" chips were rendered disabled, so `web_search`, which the engine
 *     registers and gates by name, could only be made to ask through the all-tools wildcard.
 *
 * Unlocking the chips must not swap one false promise for another: a question to the user is
 * answered by the user, so no approval setting reaches it — and since #4 it is the SDK's own
 * `AskUserQuestion`, not a registry tool, so it has no row to tick at all. And the
 * mandatory-approval tools ask whatever is stored, so an untick on them could not either.
 *
 * The first block is pure. The second opens the page but saves nothing: settings are a
 * single shared row.
 */

test.describe('settings/tool-approval — the list is the engine surface', () => {
	test('it lists exactly the registry tools the engine registers and gates', () => {
		// `buildToolServer` registers every registry tool outside ENGINE_EXCLUDED_TOOLS for an
		// unscoped run, and the engine's gate sees all of them. The one call it hands to the
		// host ungated, AskUserQuestion (HOST_OWNED_TOOLS), is the SDK's and not in the
		// registry, so there is nothing to leave out on its account. That the engine gates
		// every registry tool is pinned where the engine is driven: engine.stream-approvals.
		const gated = allToolNames.filter((name) => !ENGINE_EXCLUDED_TOOLS.has(name)).sort()
		expect(BUILTIN_TOOLS.map((t) => t.name)).toEqual(gated)
		expect([...HOST_OWNED_TOOLS]).toEqual([ASK_USER_QUESTION_TOOL])
		for (const name of HOST_OWNED_TOOLS) expect(allToolNames as readonly string[], name).not.toContain(name)
	})

	test('no entry promises a tool that is gone, hidden or never gated', () => {
		const names = new Set(BUILTIN_TOOLS.map((t) => t.name))
		for (const gone of ['run_code', 'search_tools', 'run_subagent', 'ask_user', 'AskUserQuestion']) {
			expect(names.has(gone), gone).toBe(false)
		}
		expect(names.has('web_search')).toBe(true)
	})

	test('entries carry no tier, so none can be rendered locked off', () => {
		for (const tool of BUILTIN_TOOLS) {
			expect(Object.keys(tool).sort()).toEqual(['description', 'name'])
		}
	})

	test('the tools that always ask are on the list, where the panel locks them on', () => {
		const names = new Set(BUILTIN_TOOLS.map((t) => t.name))
		for (const name of MANDATORY_APPROVAL_TOOLS) expect(names.has(name), name).toBe(true)
	})
})

test.describe('settings/tool-approval — the panel', () => {
	test('web_search can be toggled on its own, and nothing offers run_code', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/settings')
		await expect(page.getByRole('heading', { name: 'Tool Approval' })).toBeVisible()

		const webSearch = page.getByRole('checkbox', { name: 'web_search', exact: true })
		await expect(webSearch).toBeVisible()
		await expect(webSearch).toBeEnabled()

		await expect(page.getByText('Programmatic tool calling')).toHaveCount(0)
		await expect(page.getByText('Always loaded')).toHaveCount(0)
		await expect(page.getByRole('checkbox', { name: 'run_code', exact: true })).toHaveCount(0)
		await expect(page.getByRole('checkbox', { name: 'search_tools', exact: true })).toHaveCount(0)
		await expect(page.getByRole('checkbox', { name: 'ask_user', exact: true })).toHaveCount(0)
	})

	test('the mandatory-approval tools show ticked and locked, and None leaves them', async ({ page }) => {
		// They ask in every mode whatever is stored, so an untick — one by one or through
		// None — would be a setting that cannot take effect. Clicks here change the page's
		// copy of the settings only; nothing is saved.
		await authenticateContext(page.context())
		await page.goto('/settings')
		const panel = page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Tool Approval' }) })
			.last()
		await expect(panel).toBeVisible()

		for (const name of MANDATORY_APPROVAL_TOOLS) {
			const chip = panel.getByRole('checkbox', { name: new RegExp(`^${name}\\b`) })
			await expect(chip, name).toBeChecked()
			await expect(chip, name).toBeDisabled()
		}
		// One marker per locked chip, and none on any other; the panel's copy says it once more.
		await expect(panel.locator('label').getByText('always asks', { exact: true })).toHaveCount(
			MANDATORY_APPROVAL_TOOLS.length,
		)

		// The shared row may have the all-tools wildcard on, which locks the whole list.
		const wildcard = panel.getByRole('checkbox', { name: /Require approval for all tools/ })
		test.skip(await wildcard.isChecked(), 'the stored settings require approval for every tool')
		await panel.getByRole('button', { name: 'All', exact: true }).click()
		await expect(panel.getByRole('checkbox', { name: 'web_search', exact: true })).toBeChecked()
		await panel.getByRole('button', { name: 'None', exact: true }).click()
		await expect(panel.getByRole('checkbox', { name: 'web_search', exact: true })).not.toBeChecked()
		for (const name of MANDATORY_APPROVAL_TOOLS) {
			await expect(panel.getByRole('checkbox', { name: new RegExp(`^${name}\\b`) }), name).toBeChecked()
		}
	})
})
