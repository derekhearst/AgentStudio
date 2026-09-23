import { expect, test } from '@playwright/test'
import {
	buildModelQuestionPrompt,
	buildObservation,
	clampDeadline,
	clampInterval,
	clampMaxChecks,
	computeNextCheckAt,
	describeCondition,
	evaluateComparison,
	extractPath,
	hashValue,
	isTerminalStatus,
	monitorConditionSchema,
	observeToolResult,
	parseYesNo,
	shouldFire,
	stableStringify,
	validateActionConfig,
	MONITOR_DEFAULT_INTERVAL_SECONDS,
	MONITOR_DEFAULT_MAX_CHECKS,
	MONITOR_HARD_MAX_CHECKS,
	MONITOR_MAX_DEADLINE_DAYS,
	MONITOR_MAX_ERROR_BACKOFF_MULTIPLIER,
	MONITOR_MAX_INTERVAL_SECONDS,
	MONITOR_MIN_INTERVAL_SECONDS,
	MONITOR_MODEL_CONTEXT_MAX_CHARS,
	MONITOR_OBSERVATION_MAX_CHARS,
	type MonitorObservation,
	type ToolResultCondition,
} from '../src/lib/monitors/condition'

/**
 * Issue #33 — long-horizon monitors, pure half.
 *
 * `src/lib/monitors/condition.ts` has no DB, no SvelteKit and no `node:` imports, so this
 * spec runs without Postgres or a dev server (same arrangement as `aaak.unit.spec.ts` and
 * `automations.cron.spec.ts`).
 *
 * What is pinned here is exactly the set of rules that stop a monitor becoming a runaway:
 *   - a `changed` monitor records a baseline on its first check and does NOT fire
 *   - firing is edge-triggered, so a condition that stays true fires once
 *   - every deadline is capped at 30 days and there is no "never" branch
 *   - errored checks back off geometrically instead of hammering
 *   - the observable-tool allowlist is read-only: `shell` and friends cannot be watched with
 */

const NOW = new Date('2026-09-21T16:00:00Z')

function observation(value: unknown, met = false): MonitorObservation {
	return buildObservation(value, met, undefined, NOW)
}

// ─────────── change detection ───────────

test.describe('monitors/condition — change detection', () => {
	test('the first observation of a `changed` monitor is a baseline and never fires', () => {
		const current = observation({ title: 'Release 1.2' })
		const result = evaluateComparison({ compare: 'changed', current, previous: null })
		expect(result.met).toBe(false)
		expect(shouldFire(result.met, false)).toBe(false)
	})

	test('`changed` fires when the hash moves and stays quiet when it does not', () => {
		const first = observation({ title: 'Release 1.2' })
		const same = observation({ title: 'Release 1.2' })
		const different = observation({ title: 'Release 1.3' })

		expect(evaluateComparison({ compare: 'changed', current: same, previous: first }).met).toBe(false)
		expect(evaluateComparison({ compare: 'changed', current: different, previous: first }).met).toBe(true)
	})

	test('key order does not count as a change', () => {
		const a = observation({ status: 'green', name: 'ci' })
		const b = observation({ name: 'ci', status: 'green' })
		expect(a.hash).toBe(b.hash)
		expect(evaluateComparison({ compare: 'changed', current: b, previous: a }).met).toBe(false)
	})

	test('stableStringify leaves bare strings bare so fetched text compares as text', () => {
		expect(stableStringify('hello')).toBe('hello')
		expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
		expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]')
	})

	test('stableStringify survives a cycle instead of throwing', () => {
		const cyclic: Record<string, unknown> = { name: 'loop' }
		cyclic.self = cyclic
		expect(() => stableStringify(cyclic)).not.toThrow()
		expect(stableStringify(cyclic)).toContain('[circular]')
	})

	test('hashValue is deterministic, order-sensitive and cheap to differ', () => {
		expect(hashValue('abc')).toBe(hashValue('abc'))
		expect(hashValue('abc')).not.toBe(hashValue('abd'))
		expect(hashValue('abc')).not.toBe(hashValue('cba'))
		expect(hashValue('')).toHaveLength(16)
	})

	test('an oversized observation is truncated for storage but hashed in full', () => {
		const long = 'x'.repeat(10_000)
		const obs = observation(long)
		expect(obs.truncated).toBe(true)
		expect(obs.value.length).toBeLessThan(long.length)
		expect(obs.hash).toBe(hashValue(long))
		// Two long values differing only past the truncation point still register as a change.
		const other = observation(`${'x'.repeat(9_999)}y`)
		expect(other.hash).not.toBe(obs.hash)
	})
})

// ─────────── extraction ───────────

test.describe('monitors/condition — extractPath', () => {
	const root = { text: 'hello', items: [{ title: 'a' }, { title: 'b' }], nested: { deep: { n: 7 } } }

	test('walks objects, arrays and negative indices', () => {
		expect(extractPath(root, 'text')).toBe('hello')
		expect(extractPath(root, 'items.1.title')).toBe('b')
		expect(extractPath(root, 'items.-1.title')).toBe('b')
		expect(extractPath(root, 'nested.deep.n')).toBe(7)
	})

	test('an empty path returns the whole result and a missing path returns undefined', () => {
		expect(extractPath(root, '')).toBe(root)
		expect(extractPath(root, undefined)).toBe(root)
		expect(extractPath(root, 'nope.at.all')).toBeUndefined()
		expect(extractPath(root, 'items.notanindex')).toBeUndefined()
	})
})

// ─────────── comparisons ───────────

test.describe('monitors/condition — comparisons', () => {
	const current = observation('CI status: SUCCESS')

	test('equals / contains / matches / not_empty behave as written on the tin', () => {
		expect(evaluateComparison({ compare: 'contains', current, expected: 'success', previous: null }).met).toBe(true)
		expect(evaluateComparison({ compare: 'not_contains', current, expected: 'failure', previous: null }).met).toBe(true)
		expect(evaluateComparison({ compare: 'matches', current, expected: 'SUCCESS$', previous: null }).met).toBe(true)
		expect(evaluateComparison({ compare: 'matches', current, expected: '^FAIL', previous: null }).met).toBe(false)
		expect(evaluateComparison({ compare: 'not_empty', current, previous: null }).met).toBe(true)
		expect(
			evaluateComparison({ compare: 'equals', current: observation('green'), expected: 'green', previous: null }).met,
		).toBe(true)
		expect(
			evaluateComparison({ compare: 'not_equals', current: observation('green'), expected: 'red', previous: null }).met,
		).toBe(true)
	})

	test('every rendering of emptiness counts as empty', () => {
		for (const empty of [null, [], {}, '']) {
			expect(evaluateComparison({ compare: 'not_empty', current: observation(empty), previous: null }).met).toBe(false)
		}
		expect(evaluateComparison({ compare: 'not_empty', current: observation(['a']), previous: null }).met).toBe(true)
	})

	test('an invalid regex is a configuration error, not a quiet false', () => {
		expect(() => evaluateComparison({ compare: 'matches', current, expected: '([', previous: null })).toThrow(
			/invalid regular expression/i,
		)
	})

	test('comparisons read the full value, not the stored cut', () => {
		// The stored value stops at MONITOR_OBSERVATION_MAX_CHARS and ends in "…"; the text
		// the monitor is watching for can sit anywhere after that.
		const page = `${'lorem ipsum '.repeat(750)}Out of stock${' dolor'.repeat(100)}`
		expect(page.indexOf('Out of stock')).toBeGreaterThan(MONITOR_OBSERVATION_MAX_CHARS)
		const stored = observation(page)
		expect(stored.value).not.toContain('Out of stock')

		const compare = (compare: 'contains' | 'not_contains' | 'matches' | 'equals', expected: string) =>
			evaluateComparison({ compare, current: stored, previous: null, expected, fullValue: page }).met

		expect(compare('contains', 'out of stock'), 'found past the cut').toBe(true)
		expect(compare('not_contains', 'Out of stock'), 'still out of stock — must not fire').toBe(false)
		expect(compare('matches', 'dolor$'), 'an anchor at the real end, not at the "…"').toBe(true)
		expect(compare('equals', page), 'a long value can equal its operand').toBe(true)
	})
})

// ─────────── observing a tool result ───────────

test.describe('monitors/condition — observeToolResult', () => {
	const webFetch = (extract: string | undefined, compare: 'changed' | 'not_contains' | 'not_equals', value?: string) =>
		monitorConditionSchema.parse({
			kind: 'tool_result',
			tool: 'web_fetch',
			args: { url: 'https://example.com/product' },
			extract,
			compare,
			value,
		}) as ToolResultCondition

	test('a phrase past the storage cut is seen, and the stored value is still cut', () => {
		const text = `${'Product details. '.repeat(600)}Out of stock`
		const result = observeToolResult(
			webFetch('text', 'not_contains', 'Out of stock'),
			{ title: 'Widget', text, fetchedAt: NOW.toISOString() },
			null,
			NOW,
		)
		expect(result.outcome).toBe('observed')
		if (result.outcome !== 'observed') return
		expect(result.met, 'the item is still out of stock').toBe(false)
		expect(result.observation.truncated).toBe(true)
		expect(result.observation.value.length).toBeLessThanOrEqual(MONITOR_OBSERVATION_MAX_CHARS + 1)
		expect(result.observation.hash).toBe(hashValue(text))
	})

	test('an extract path that is not in the result is an error, not the value "null"', () => {
		// list_pull_requests returns an array; the form used to leave `extract: "text"` in place
		// when the tool changed, and every check then observed the literal "null".
		const condition = monitorConditionSchema.parse({
			kind: 'tool_result',
			tool: 'list_pull_requests',
			args: { owner: 'acme', repo: 'widgets' },
			extract: 'text',
			compare: 'not_equals',
			value: 'x',
		}) as ToolResultCondition
		const result = observeToolResult(condition, [{ number: 412, title: 'Fix it' }], null, NOW)
		expect(result.outcome).toBe('error')
		if (result.outcome !== 'error') return
		expect(result.message).toContain('"text"')
		expect(result.message).toContain('list_pull_requests')
	})

	test('an explicit null at the path is a real observation', () => {
		const condition = monitorConditionSchema.parse({
			kind: 'tool_result',
			tool: 'get_pull_request',
			args: { pullRequestId: '00000000-0000-0000-0000-000000000000' },
			extract: 'mergedAt',
			compare: 'not_empty',
		}) as ToolResultCondition
		const result = observeToolResult(condition, { number: 412, mergedAt: null }, null, NOW)
		expect(result.outcome).toBe('observed')
		if (result.outcome !== 'observed') return
		expect(result.met, 'not merged yet').toBe(false)
	})

	test('no extract compares the whole result', () => {
		const result = observeToolResult(webFetch(undefined, 'changed'), { text: 'hello' }, null, NOW)
		expect(result.outcome).toBe('observed')
		if (result.outcome !== 'observed') return
		expect(result.observation.value).toBe('{"text":"hello"}')
		expect(result.met, 'first check of `changed` is a baseline').toBe(false)
	})
})

// ─────────── debounce ───────────

test.describe('monitors/condition — debounce', () => {
	test('fires once per rising edge, not once per check', () => {
		// met, previouslyMet, expected
		const table: Array<[boolean, boolean, boolean]> = [
			[false, false, false],
			[true, false, true], // the edge
			[true, true, false], // still true — already fired
			[false, true, false], // re-arms
			[true, false, true], // next edge
		]
		for (const [met, previouslyMet, expected] of table) {
			expect(shouldFire(met, previouslyMet)).toBe(expected)
		}
	})

	test('a condition that is true for a hundred consecutive checks produces one fire', () => {
		let latch = false
		let fires = 0
		for (let i = 0; i < 100; i++) {
			if (shouldFire(true, latch)) fires += 1
			latch = true
		}
		expect(fires).toBe(1)
	})
})

// ─────────── caps ───────────

test.describe('monitors/condition — caps', () => {
	test('there is no "no deadline" — omitting one yields the 30-day ceiling', () => {
		const ceiling = NOW.getTime() + MONITOR_MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1000
		expect(clampDeadline(null, NOW).getTime()).toBe(ceiling)
		expect(clampDeadline(undefined, NOW).getTime()).toBe(ceiling)
		expect(clampDeadline('not a date', NOW).getTime()).toBe(ceiling)
	})

	test('a deadline beyond the ceiling is silently capped at the ceiling', () => {
		const ceiling = NOW.getTime() + MONITOR_MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1000
		const requested = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000)
		expect(clampDeadline(requested, NOW).getTime()).toBe(ceiling)
	})

	test('a deadline in the past yields one interval out, so a monitor is never born expired', () => {
		const past = new Date(NOW.getTime() - 60 * 60 * 1000)
		expect(clampDeadline(past, NOW, 900).getTime()).toBe(NOW.getTime() + 900 * 1000)
	})

	test('a deadline inside the window is respected exactly', () => {
		const requested = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000)
		expect(clampDeadline(requested, NOW).toISOString()).toBe(requested.toISOString())
	})

	test('interval is floored at a minute and ceilinged at a day', () => {
		expect(clampInterval(1)).toBe(MONITOR_MIN_INTERVAL_SECONDS)
		expect(clampInterval(0)).toBe(MONITOR_MIN_INTERVAL_SECONDS)
		expect(clampInterval(-5)).toBe(MONITOR_MIN_INTERVAL_SECONDS)
		expect(clampInterval(999_999)).toBe(MONITOR_MAX_INTERVAL_SECONDS)
		expect(clampInterval(900)).toBe(900)
		expect(clampInterval(Number.NaN)).toBe(MONITOR_DEFAULT_INTERVAL_SECONDS)
	})

	test('the check budget has a default and a hard ceiling', () => {
		expect(clampMaxChecks(undefined)).toBe(MONITOR_DEFAULT_MAX_CHECKS)
		expect(clampMaxChecks(0)).toBe(1)
		expect(clampMaxChecks(10_000_000)).toBe(MONITOR_HARD_MAX_CHECKS)
		expect(clampMaxChecks(50)).toBe(50)
	})
})

// ─────────── scheduling ───────────

test.describe('monitors/condition — scheduling', () => {
	test('a healthy check lands exactly one interval out', () => {
		expect(computeNextCheckAt(NOW, 900, 0).getTime()).toBe(NOW.getTime() + 900_000)
	})

	test('errors back off geometrically and then stop growing', () => {
		expect(computeNextCheckAt(NOW, 60, 1).getTime()).toBe(NOW.getTime() + 2 * 60_000)
		expect(computeNextCheckAt(NOW, 60, 2).getTime()).toBe(NOW.getTime() + 4 * 60_000)
		expect(computeNextCheckAt(NOW, 60, 3).getTime()).toBe(NOW.getTime() + 8 * 60_000)
		// Capped, so a long-dead host never pushes the next check into next week.
		expect(computeNextCheckAt(NOW, 60, 9).getTime()).toBe(
			NOW.getTime() + MONITOR_MAX_ERROR_BACKOFF_MULTIPLIER * 60_000,
		)
	})

	test('terminal statuses are the ones that never get checked again', () => {
		for (const status of ['fired', 'expired', 'exhausted', 'failed', 'canceled']) {
			expect(isTerminalStatus(status)).toBe(true)
		}
		expect(isTerminalStatus('active')).toBe(false)
		expect(isTerminalStatus('paused')).toBe(false)
	})
})

// ─────────── model path ───────────

test.describe('monitors/condition — model path', () => {
	test('parses the answers a cheap model actually produces', () => {
		for (const yes of ['YES', 'yes', 'Yes — checks are green', '**YES**, all green', 'true']) {
			expect(parseYesNo(yes)).toBe(true)
		}
		for (const no of ['NO', 'no', 'No — still running', '"NO" (not yet)', 'false']) {
			expect(parseYesNo(no)).toBe(false)
		}
	})

	test('an unreadable answer is null so the runner can treat it as an error', () => {
		expect(parseYesNo('')).toBeNull()
		expect(parseYesNo('I am not sure, could you clarify?')).toBeNull()
		expect(parseYesNo('maybe')).toBeNull()
	})

	test('context is truncated so the per-check cost stays bounded', () => {
		const prompt = buildModelQuestionPrompt('Is it green?', 'x'.repeat(MONITOR_MODEL_CONTEXT_MAX_CHARS * 2))
		expect(prompt).toContain('context truncated')
		expect(prompt.length).toBeLessThan(MONITOR_MODEL_CONTEXT_MAX_CHARS + 1_000)
		expect(prompt).toContain('Is it green?')
	})
})

// ─────────── schema ───────────

test.describe('monitors/condition — schema', () => {
	test('the observable-tool allowlist is read-only', () => {
		for (const forbidden of ['Bash', 'Write', 'push_branch', 'run_code', 'delete_file']) {
			const parsed = monitorConditionSchema.safeParse({
				kind: 'tool_result',
				tool: forbidden,
				args: {},
				compare: 'changed',
			})
			expect(parsed.success, `${forbidden} must not be observable`).toBe(false)
		}
		expect(
			monitorConditionSchema.safeParse({
				kind: 'tool_result',
				tool: 'web_fetch',
				args: { url: 'https://example.com' },
				extract: 'text',
				compare: 'changed',
			}).success,
		).toBe(true)
	})

	test('a model_question must bring context with it', () => {
		expect(
			monitorConditionSchema.safeParse({ kind: 'model_question', question: 'Is it done?', context: [] }).success,
		).toBe(false)
		expect(
			monitorConditionSchema.safeParse({
				kind: 'model_question',
				question: 'Is it done?',
				context: [{ tool: 'web_fetch', args: { url: 'https://example.com' } }],
			}).success,
		).toBe(true)
	})

	test('compare defaults to `changed` when omitted', () => {
		const parsed = monitorConditionSchema.parse({ kind: 'tool_result', tool: 'git_status', args: {} })
		expect(parsed.kind === 'tool_result' && parsed.compare).toBe('changed')
	})

	test('actions that need config say so instead of firing into the void', () => {
		expect(validateActionConfig('start_conversation', {})).toMatch(/prompt/)
		expect(validateActionConfig('start_conversation', { prompt: 'look at this' })).toBeNull()
		expect(validateActionConfig('run_automation', {})).toMatch(/automationId/)
		expect(validateActionConfig('run_automation', { automationId: '00000000-0000-0000-0000-000000000000' })).toBeNull()
		expect(validateActionConfig('push', {})).toBeNull()
		expect(validateActionConfig('review_item', {})).toBeNull()
	})

	test('describeCondition renders something a human can read in a list', () => {
		expect(
			describeCondition({ kind: 'tool_result', tool: 'web_fetch', args: {}, extract: 'text', compare: 'changed' }),
		).toBe('web_fetch.text changes')
		expect(describeCondition({ kind: 'tool_result', tool: 'git_status', args: {}, compare: 'not_empty' })).toBe(
			'git_status is non-empty',
		)
		expect(
			describeCondition({
				kind: 'tool_result',
				tool: 'web_fetch',
				args: {},
				compare: 'contains',
				value: 'v2.0',
			}),
		).toBe('web_fetch contains "v2.0"')
		expect(
			describeCondition({
				kind: 'model_question',
				question: 'Are checks green?',
				context: [{ tool: 'list_pull_requests', args: {} }],
			}),
		).toContain('Are checks green?')
	})
})

// ─────────── agent-facing tool surface ───────────

test.describe('monitors — agent tool schema', () => {
	test('create_monitor is registered and enforces the same allowlist as the domain', async () => {
		const { toolSchemas } = await import('../src/lib/tools/tool-schemas')
		expect(toolSchemas.create_monitor).toBeTruthy()
		const ok = toolSchemas.create_monitor.safeParse({
			name: 'Release page',
			condition: { kind: 'tool_result', tool: 'web_fetch', args: { url: 'https://example.com' }, extract: 'text' },
			action: 'push',
		})
		expect(ok.success).toBe(true)

		const forbidden = toolSchemas.create_monitor.safeParse({
			name: 'Sneaky',
			condition: { kind: 'tool_result', tool: 'Bash', args: { command: 'rm -rf /' } },
			action: 'push',
		})
		expect(forbidden.success).toBe(false)
	})

	test('create_monitor refuses a deadline past the 30-day ceiling at the schema boundary', async () => {
		const { toolSchemas } = await import('../src/lib/tools/tool-schemas')
		const tooLong = toolSchemas.create_monitor.safeParse({
			name: 'Forever',
			condition: { kind: 'tool_result', tool: 'git_status', args: {} },
			action: 'review_item',
			deadlineDays: 365,
		})
		expect(tooLong.success).toBe(false)
	})

	test('the monitor lifecycle tools all exist', async () => {
		const { toolSchemas } = await import('../src/lib/tools/tool-schemas')
		expect(toolSchemas.list_monitors).toBeTruthy()
		expect(toolSchemas.cancel_monitor).toBeTruthy()
		expect(toolSchemas.extend_monitor).toBeTruthy()
		expect(toolSchemas.cancel_monitor.safeParse({ monitorId: 'not-a-uuid' }).success).toBe(false)
	})
})
