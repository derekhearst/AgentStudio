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
 * tool that cannot work on the engine path.** The one exclusion left was a live defect, not
 * tidying: `run_subagent` dispatched by `agentId`, a uuid nothing ever put in the model's
 * context. Replaced by the SDK's `Task` against `Options.agents` (#5), not removed.
 *
 * Two tools used to be excluded here and were deleted from the registry instead, because an
 * exclusion only hides a tool from the engine and every other surface that lists the
 * registry — the settings approval list, the MCP endpoint — kept offering it:
 *
 *   - `search_tools` implemented deferred loading, which only the old loop ever had. On
 *     this path it could only tell the model it had loaded tools already in its tools array.
 *   - `run_code` threw on this path: it needed a `runtime` in `toolUserContext` that only
 *     the old loop supplied (#69).
 *
 * Every name in the exclusion set must still be a real tool, because a typo there silently
 * excludes nothing and the lie comes back.
 */

const has = (name: string) => allToolNames.includes(name as (typeof allToolNames)[number])

test('the exclusion set names real tools, so a typo cannot silently do nothing', () => {
	for (const name of ENGINE_EXCLUDED_TOOLS) {
		expect(has(name)).toBe(true)
	}
})

test('search_tools is gone from the registry, not merely hidden (#8)', () => {
	// Deferred loading is not implemented anywhere any more; advertising it costs a round and
	// the model's trust in what its prompt tells it.
	expect(has('search_tools')).toBe(false)
	expect(ENGINE_EXCLUDED_TOOLS.has('search_tools')).toBe(false)
})

test('run_code is gone from the registry, not merely hidden (#69)', () => {
	// Scripts run through the SDK's sandboxed `Bash` now. There is no in-script tool calling.
	expect(has('run_code')).toBe(false)
	expect(ENGINE_EXCLUDED_TOOLS.has('run_code')).toBe(false)
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
	expect(ENGINE_EXCLUDED_TOOLS.size).toBe(1)
})
