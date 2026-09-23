import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { authenticateContext } from './helpers'
import { ENGINE_EXCLUDED_TOOLS, HOST_OWNED_TOOLS } from '../src/lib/engine/builtin-tools'
import { allToolNames } from '../src/lib/tools/tool-schemas'
import { BUILTIN_TOOLS } from '../src/lib/tools/tools'

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
 * Unlocking the chips must not swap one false promise for another: `ask_user` is handed to
 * the host before any approval gate runs, so a tick on it could never take effect.
 *
 * The first test is pure. The second opens the page but saves nothing: settings are a single
 * shared row.
 */

test.describe('settings/tool-approval — the list is the engine surface', () => {
	test('it lists exactly the registry tools the engine registers and gates', () => {
		// `buildToolServer` registers every registry tool outside ENGINE_EXCLUDED_TOOLS for an
		// unscoped run, and the engine's gate sees all of them but HOST_OWNED_TOOLS — the same
		// set `runEngineStream` reads to skip its PreToolUse hook and `canUseTool`. A setting
		// for anything else could never take effect.
		const gated = allToolNames
			.filter((name) => !ENGINE_EXCLUDED_TOOLS.has(name) && !HOST_OWNED_TOOLS.has(name))
			.sort()
		expect(BUILTIN_TOOLS.map((t) => t.name)).toEqual(gated)
	})

	test('the engine reads the host-owned set from builtin-tools, not a copy of its own', () => {
		// A second hand-written set in the engine could drift from the one this list is
		// filtered by, and the test above would not notice. Source-level, because importing
		// the stream module from the Playwright runtime pulls in the SDK.
		const source = readFileSync(resolve(process.cwd(), 'src/lib/engine/stream.server.ts'), 'utf8')
		expect(source).toMatch(/import \{ HOST_OWNED_TOOLS \} from '\.\/builtin-tools'/)
		expect(source).not.toMatch(/const HOST_OWNED_TOOLS\b/)
		expect(HOST_OWNED_TOOLS.has('ask_user')).toBe(true)
	})

	test('no entry promises a tool that is gone, hidden or never gated', () => {
		const names = new Set(BUILTIN_TOOLS.map((t) => t.name))
		for (const gone of ['run_code', 'search_tools', 'run_subagent', 'ask_user']) {
			expect(names.has(gone), gone).toBe(false)
		}
		expect(names.has('web_search')).toBe(true)
	})

	test('entries carry no tier, so none can be rendered locked', () => {
		for (const tool of BUILTIN_TOOLS) {
			expect(Object.keys(tool).sort()).toEqual(['description', 'name'])
		}
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
})
