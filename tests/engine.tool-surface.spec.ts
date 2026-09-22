import { expect, test } from '@playwright/test'
import { ENGINE_EXCLUDED_TOOLS } from '../src/lib/engine/builtin-tools'
import { allToolNames } from '../src/lib/tools/tool-schemas'

/**
 * Which registry tools the engine actually exposes.
 *
 * Pure-function tests: both modules are plain data and `ENGINE_EXCLUDED_TOOLS` is a `Set`,
 * so this runs without Postgres or a dev server (same arrangement as
 * `automations.cron.spec.ts`).
 *
 * The rule this pins is narrow and worth stating plainly: **the engine must not register a
 * tool that cannot work on the engine path.** Both current exclusions were live defects,
 * not tidying:
 *
 *   - `search_tools` implements deferred loading, which is real on the old loop
 *     (`getToolDefinitions` filters by tier) and has never been real here — the engine
 *     registers the whole registry on round one. It could only ever tell the model it had
 *     loaded tools that were already in its tools array.
 *   - `run_code` throws on this path outright: it needs a `runtime` in `toolUserContext`
 *     that only `$lib/runtime/tool-handlers.server` supplies.
 *   - `run_subagent` dispatched by `agentId`, a uuid nothing ever put in the model's
 *     context. Replaced by the SDK's `Task` against `Options.agents` (#5), not removed.
 *
 * Every name in the exclusion set must still be a real tool, because a typo there silently
 * excludes nothing and the lie comes back.
 */

test('the exclusion set names real tools, so a typo cannot silently do nothing', () => {
	for (const name of ENGINE_EXCLUDED_TOOLS) {
		expect(allToolNames.includes(name as (typeof allToolNames)[number])).toBe(true)
	}
})

test('search_tools is not on the engine surface', () => {
	// Deferred loading is not implemented here; advertising it costs a round and the
	// model's trust in what its prompt tells it.
	expect(ENGINE_EXCLUDED_TOOLS.has('search_tools')).toBe(true)
})

test('run_code is not on the engine surface', () => {
	// It cannot run without runtime context, which this path never supplies. If someone
	// gives the engine its own approval route for nested calls, delete this line — do not
	// register it back while the throw is still there.
	expect(ENGINE_EXCLUDED_TOOLS.has('run_code')).toBe(true)
})

test('run_subagent is not on the engine surface', () => {
	// Delegation is `Task` now. Two tools for one job would mean the model could pick the
	// one that renders no nested transcript — and could only name an agent by guessing a
	// uuid. Do not register it back while `Options.agents` is what describes the agents.
	expect(ENGINE_EXCLUDED_TOOLS.has('run_subagent')).toBe(true)
})

test('the exclusions stay narrow — everything else is still exposed', () => {
	// A guard against the set quietly becoming a dumping ground. These are the tools the
	// engine path exists to offer; none of them should ever appear in the exclusions.
	const mustBeExposed = [
		'web_search',
		'web_fetch',
		'ask_user',
		'create_monitor',
		'create_automation',
		'push_branch',
		'create_pull_request',
		'image_generate',
	]
	for (const name of mustBeExposed) {
		expect(ENGINE_EXCLUDED_TOOLS.has(name)).toBe(false)
	}
	expect(ENGINE_EXCLUDED_TOOLS.size).toBe(3)
})
