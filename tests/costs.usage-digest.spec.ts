import { expect, test } from '@playwright/test'
import {
	BUDGET_NEAR_LIMIT_PCT,
	DEFAULT_USAGE_DIGEST_DAYS,
	DIGEST_MARKDOWN_MAX_ANOMALIES,
	MAX_USAGE_DIGEST_DAYS,
	MIN_FINISHED_RUNS_FOR_RATE,
	MONITOR_ERROR_STREAK_ALERT,
	RUN_FAILURE_RATE_ALERT,
	SPEND_SPIKE_FLOOR_USD,
	SPIKE_RATIO,
	TOKEN_SPIKE_FLOOR,
	USAGE_DIGEST_PROMPT,
	assembleUsageDigest,
	automationHistoryCoversPreviousWindow,
	detectAnomalies,
	failureRate,
	parseUsageDigestPrompt,
	renderDigestMarkdown,
	resolveDigestWindow,
	type DigestAutomation,
	type DigestBudgetHeadroom,
	type DigestMonitor,
	type UsageDigestInput,
} from '../src/lib/costs/usage-digest'
import { AUTOMATION_RUN_RETENTION_DAYS } from '../src/lib/automations/failure-policy'

/**
 * #38 — the usage digest's pure half: window math, anomaly thresholds, assembly and the
 * markdown the weekly digest sends.
 *
 * `src/lib/costs/usage-digest.ts` has no DB and no SvelteKit, so this runs without Postgres
 * or a dev server (same arrangement as `costs.tool-call-ledger.spec.ts`). The queries are
 * pinned against a real database in `costs.usage-digest-live.spec.ts`.
 *
 * The thresholds are guesses, so each is pinned at its edge: firing at the threshold and
 * not just below it. A digest that cries wolf gets ignored, so the floors matter as much
 * as the ratios — $0.01 → $0.03 is triple, and it is not news.
 */

const NOW = new Date('2026-09-23T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function totals(overrides: Partial<UsageDigestInput['llm']['current']> = {}) {
	return { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, calls: 0, ...overrides }
}

function baseInput(overrides: Partial<UsageDigestInput> = {}): UsageDigestInput {
	return {
		window: resolveDigestWindow(7, NOW),
		llm: { current: totals(), previous: totals() },
		models: [],
		agents: [],
		runStates: [],
		automations: [],
		tools: { calls: 0, failed: 0, costUsd: 0, previousCostUsd: 0, top: [] },
		budget: [],
		inbox: [],
		monitors: [],
		...overrides,
	}
}

function automation(overrides: Partial<DigestAutomation> = {}): DigestAutomation {
	return {
		automationId: 'a1',
		description: 'Nightly triage',
		enabled: true,
		disabledReason: null,
		disabledInWindow: false,
		runs: 3,
		completed: 3,
		failed: 0,
		blocked: 0,
		costUsd: 0,
		prevFailed: 0,
		...overrides,
	}
}

function monitor(overrides: Partial<DigestMonitor> = {}): DigestMonitor {
	return {
		monitorId: 'm1',
		name: 'Release watch',
		status: 'expired',
		fireCount: 0,
		consecutiveErrors: 0,
		updatedInWindow: true,
		...overrides,
	}
}

function limit(overrides: Partial<DigestBudgetHeadroom> = {}): DigestBudgetHeadroom {
	return {
		id: 'l1',
		scope: 'global',
		scopeId: null,
		scopeLabel: null,
		period: 'month',
		limitUsd: 100,
		spendUsd: 10,
		pct: 0.1,
		action: 'block',
		...overrides,
	}
}

const kinds = (input: UsageDigestInput) => detectAnomalies(input).map((a) => a.kind)

test.describe('costs/usage-digest — window', () => {
	test('a rolling window ends now and the previous window is contiguous and the same length', () => {
		for (const days of [1, 7, 30]) {
			const window = resolveDigestWindow(days, NOW)
			expect(window.days).toBe(days)
			expect(window.until.getTime()).toBe(NOW.getTime())
			expect(window.until.getTime() - window.since.getTime()).toBe(days * DAY)
			// Contiguous: the previous window ends exactly where this one starts.
			expect(window.since.getTime() - window.prevSince.getTime()).toBe(days * DAY)
		}
	})

	test('the window is clamped to 1–30 days', () => {
		expect(resolveDigestWindow(0, NOW).days).toBe(1)
		expect(resolveDigestWindow(90, NOW).days).toBe(MAX_USAGE_DIGEST_DAYS)
		expect(resolveDigestWindow(Number.NaN, NOW).days).toBe(DEFAULT_USAGE_DIGEST_DAYS)
	})
})

test.describe('costs/usage-digest — the digest prompt', () => {
	test('the bare placeholder is the default week, and a suffix picks the days', () => {
		expect(parseUsageDigestPrompt(USAGE_DIGEST_PROMPT)).toBe(DEFAULT_USAGE_DIGEST_DAYS)
		expect(parseUsageDigestPrompt('  {{ usage_digest }}\n')).toBe(DEFAULT_USAGE_DIGEST_DAYS)
		expect(parseUsageDigestPrompt('{{usage_digest:30}}')).toBe(30)
		expect(parseUsageDigestPrompt('{{usage_digest:1}}')).toBe(1)
	})

	test('an out-of-range window is clamped, never handed to a model as literal text', () => {
		expect(parseUsageDigestPrompt('{{usage_digest:365}}')).toBe(MAX_USAGE_DIGEST_DAYS)
		expect(parseUsageDigestPrompt('{{usage_digest:0}}')).toBe(1)
	})

	test('a prompt with anything around the placeholder is not the digest', () => {
		// Text around it would be an instruction for a model, and the digest path has none.
		expect(parseUsageDigestPrompt('Summarise {{usage_digest}} for me')).toBeNull()
		expect(parseUsageDigestPrompt('Say hello')).toBeNull()
		expect(parseUsageDigestPrompt('{{usage_digest:abc}}')).toBeNull()
		expect(parseUsageDigestPrompt('')).toBeNull()
		expect(parseUsageDigestPrompt(null)).toBeNull()
	})
})

test.describe('costs/usage-digest — failure rate', () => {
	test('canceled and in-flight runs are not failures, and too few finished runs give no rate', () => {
		expect(failureRate({ completed: 3, failed: 1 })).toBe(0.25)
		expect(failureRate({ completed: MIN_FINISHED_RUNS_FOR_RATE - 2, failed: 1 })).toBeNull()

		const digest = assembleUsageDigest(
			baseInput({
				runStates: [
					{ state: 'completed', count: 6 },
					{ state: 'failed', count: 2 },
					{ state: 'canceled', count: 5 },
					{ state: 'running', count: 1 },
					{ state: 'waiting_tool_approval', count: 1 },
				],
			}),
		)
		expect(digest.runs).toEqual({ total: 15, completed: 6, failed: 2, canceled: 5, inFlight: 2, failureRate: 0.25 })
	})

	test('the failure-rate anomaly fires at the threshold, not below it, and not on a tiny sample', () => {
		const at = baseInput({ runStates: [{ state: 'completed', count: 3 }, { state: 'failed', count: 1 }] })
		expect(RUN_FAILURE_RATE_ALERT).toBe(0.25)
		expect(kinds(at)).toContain('run_failure_rate')

		const below = baseInput({ runStates: [{ state: 'completed', count: 4 }, { state: 'failed', count: 1 }] })
		expect(kinds(below)).not.toContain('run_failure_rate')

		const tiny = baseInput({ runStates: [{ state: 'failed', count: MIN_FINISHED_RUNS_FOR_RATE - 1 }] })
		expect(kinds(tiny), 'three failures out of three is not a rate yet').not.toContain('run_failure_rate')
	})
})

test.describe('costs/usage-digest — spikes', () => {
	test('spend must beat the previous window by the ratio and clear the floor', () => {
		const spike = (current: number, previous: number) =>
			kinds(baseInput({ llm: { current: totals({ costUsd: current }), previous: totals({ costUsd: previous }) } }))

		expect(spike(SPEND_SPIKE_FLOOR_USD * 3, SPEND_SPIKE_FLOOR_USD)).toContain('spend_spike')
		// Exactly the ratio is not "more than" it.
		expect(spike(2, 2 / SPIKE_RATIO)).not.toContain('spend_spike')
		// The floor: $0.01 → $0.03 triples and is still not news.
		expect(spike(0.03, 0.01)).not.toContain('spend_spike')
		// From nothing to over the floor is a spike.
		expect(spike(SPEND_SPIKE_FLOOR_USD, 0)).toContain('spend_spike')
	})

	test('metered spend includes paid tools', () => {
		const input = baseInput({
			llm: { current: totals({ costUsd: 0.5 }), previous: totals() },
			tools: { calls: 1, failed: 0, costUsd: 0.6, previousCostUsd: 0, top: [] },
		})
		expect(kinds(input)).toContain('spend_spike')
		expect(assembleUsageDigest(input).metered.usd).toBeCloseTo(1.1)
	})

	test('tokens spike on in + out, with their own floor', () => {
		const spike = (current: number, previous: number) =>
			kinds(
				baseInput({
					llm: { current: totals({ tokensIn: current / 2, tokensOut: current / 2 }), previous: totals({ tokensIn: previous }) },
				}),
			)
		expect(spike(TOKEN_SPIKE_FLOOR, TOKEN_SPIKE_FLOOR / 4)).toContain('token_spike')
		expect(spike(TOKEN_SPIKE_FLOOR - 2, 0), 'below the floor').not.toContain('token_spike')
		expect(spike(TOKEN_SPIKE_FLOOR * 2, TOKEN_SPIKE_FLOOR), 'exactly double').not.toContain('token_spike')

		// Cache reads are not a spike: they dwarf everything else and cost far less.
		const cacheOnly = baseInput({
			llm: { current: totals({ tokensCacheRead: TOKEN_SPIKE_FLOOR * 10 }), previous: totals() },
		})
		expect(kinds(cacheOnly)).not.toContain('token_spike')
	})
})

test.describe('costs/usage-digest — automations and monitors', () => {
	test('an automation is newly failing only when the previous window had no failures', () => {
		expect(kinds(baseInput({ automations: [automation({ failed: 1 })] }))).toContain('automation_newly_failing')
		expect(kinds(baseInput({ automations: [automation({ failed: 2, prevFailed: 1 })] }))).not.toContain(
			'automation_newly_failing',
		)
		expect(kinds(baseInput({ automations: [automation()] }))).toEqual([])
	})

	test('"newly failing" is not judged once the previous window is older than the run history', () => {
		// The ledger keeps AUTOMATION_RUN_RETENTION_DAYS of runs. For a 30-day window the
		// previous 30 days are already pruned, so prevFailed is always 0 — a weekly job that
		// fails every week would otherwise be reported as failing for the first time.
		expect(AUTOMATION_RUN_RETENTION_DAYS).toBe(30)
		expect(MAX_USAGE_DIGEST_DAYS).toBe(AUTOMATION_RUN_RETENTION_DAYS)
		const failingEveryWeek = automation({ failed: 4, prevFailed: 0 })
		const at = (days: number) =>
			kinds(baseInput({ window: resolveDigestWindow(days, NOW), automations: [failingEveryWeek] }))

		expect(at(30)).not.toContain('automation_newly_failing')
		// The edge: half the retention is the longest window whose previous window is kept whole.
		expect(at(AUTOMATION_RUN_RETENTION_DAYS / 2)).toContain('automation_newly_failing')
		expect(at(AUTOMATION_RUN_RETENTION_DAYS / 2 + 1)).not.toContain('automation_newly_failing')
		expect(at(7)).toContain('automation_newly_failing')
		expect(automationHistoryCoversPreviousWindow(1)).toBe(true)
		expect(automationHistoryCoversPreviousWindow(30)).toBe(false)

		// Switched off is about the current window only, so it is still reported at 30 days.
		const off = automation({ failed: 5, disabledReason: 'consecutive_failures', disabledInWindow: true })
		expect(kinds(baseInput({ window: resolveDigestWindow(30, NOW), automations: [off] }))).toEqual([
			'automation_disabled',
		])
	})

	test('an automation the failure policy switched off in the window is critical, and said once', () => {
		const anomalies = detectAnomalies(
			baseInput({
				automations: [
					automation({
						failed: 3,
						enabled: false,
						disabledReason: 'consecutive_failures',
						disabledInWindow: true,
					}),
				],
			}),
		)
		expect(anomalies.map((a) => a.kind)).toEqual(['automation_disabled'])
		expect(anomalies[0].severity).toBe('critical')
		expect(anomalies[0].href).toBe('/automations')
	})

	test('a monitor that retired without ever firing is flagged; one that fired, or retired earlier, is not', () => {
		for (const status of ['expired', 'exhausted', 'failed']) {
			expect(kinds(baseInput({ monitors: [monitor({ status })] })), status).toContain('monitor_never_fired')
		}
		expect(kinds(baseInput({ monitors: [monitor({ fireCount: 1 })] }))).toEqual([])
		expect(kinds(baseInput({ monitors: [monitor({ updatedInWindow: false })] }))).toEqual([])
		// Canceled by the owner is not an anomaly.
		expect(kinds(baseInput({ monitors: [monitor({ status: 'canceled' })] }))).toEqual([])
	})

	test('an active monitor is flagged once its error streak reaches the threshold', () => {
		const at = monitor({ status: 'active', consecutiveErrors: MONITOR_ERROR_STREAK_ALERT })
		const below = monitor({ status: 'active', consecutiveErrors: MONITOR_ERROR_STREAK_ALERT - 1 })
		expect(kinds(baseInput({ monitors: [at] }))).toEqual(['monitor_erroring'])
		expect(kinds(baseInput({ monitors: [below] }))).toEqual([])
	})
})

test.describe('costs/usage-digest — budget headroom', () => {
	test('a limit is flagged at 80% spent and is critical once over', () => {
		expect(BUDGET_NEAR_LIMIT_PCT).toBe(0.8)
		expect(kinds(baseInput({ budget: [limit({ pct: 0.79 })] }))).toEqual([])

		const near = detectAnomalies(baseInput({ budget: [limit({ pct: 0.8, spendUsd: 80 })] }))
		expect(near.map((a) => [a.kind, a.severity])).toEqual([['budget_near_limit', 'warning']])

		const over = detectAnomalies(baseInput({ budget: [limit({ pct: 1.2, spendUsd: 120 })] }))
		expect(over[0].severity).toBe('critical')
	})

	test('the tightest limit leads, and no limits at all reads as none set', () => {
		const digest = assembleUsageDigest(
			baseInput({ budget: [limit({ id: 'loose', pct: 0.1 }), limit({ id: 'tight', pct: 0.6 })] }),
		)
		expect(digest.budget.tightest?.id).toBe('tight')
		expect(assembleUsageDigest(baseInput()).budget.tightest).toBeNull()
		expect(renderDigestMarkdown(assembleUsageDigest(baseInput()))).toContain('**Budget:** No limits set')
	})
})

test.describe('costs/usage-digest — assembly', () => {
	test('critical anomalies come first', () => {
		const anomalies = detectAnomalies(
			baseInput({
				automations: [
					automation({ automationId: 'new', failed: 1 }),
					automation({ automationId: 'off', disabledReason: 'consecutive_failures', disabledInWindow: true, failed: 3 }),
				],
			}),
		)
		expect(anomalies.map((a) => a.kind)).toEqual(['automation_disabled', 'automation_newly_failing'])
	})

	test('breakdowns are ranked by tokens, capped, and subscription usage is noticed', () => {
		const models = Array.from({ length: 8 }, (_, i) => ({
			model: `m${i}`,
			tokensIn: i * 100,
			tokensOut: 0,
			tokensCacheRead: 0,
			tokensCacheWrite: 0,
			costUsd: 0,
			calls: 1,
			subscription: i === 3,
		}))
		const digest = assembleUsageDigest(baseInput({ models }))
		expect(digest.models.map((m) => m.model)).toEqual(['m7', 'm6', 'm5', 'm4', 'm3'])
		expect(digest.hasSubscriptionUsage).toBe(true)
	})

	test('automations with runs only in the previous window are left out of the list', () => {
		const digest = assembleUsageDigest(
			baseInput({
				automations: [
					automation({ automationId: 'quiet', runs: 0, completed: 0, prevFailed: 2 }),
					automation({ automationId: 'busy', runs: 4, completed: 3, failed: 1, costUsd: 0.2 }),
				],
			}),
		)
		expect(digest.automations.items.map((a) => a.automationId)).toEqual(['busy'])
		expect(digest.automations).toMatchObject({ runs: 4, completed: 3, failed: 1 })
	})

	test('the inbox is counted by severity', () => {
		const digest = assembleUsageDigest(
			baseInput({
				inbox: [
					{ severity: 'critical', count: 1 },
					{ severity: 'warning', count: 3 },
					{ severity: 'info', count: 2 },
				],
			}),
		)
		expect(digest.inbox).toEqual({ open: 6, critical: 1, warning: 3, info: 2 })
	})
})

test.describe('costs/usage-digest — markdown', () => {
	test('numbers plus anomalies, tokens before dollars, and the subscription caveat', () => {
		const digest = assembleUsageDigest(
			baseInput({
				llm: {
					current: totals({ tokensIn: 1_200_000, tokensOut: 300_000, tokensCacheRead: 9_000_000, calls: 40 }),
					previous: totals({ tokensIn: 100_000 }),
				},
				models: [
					{
						model: 'claude-sonnet-5',
						tokensIn: 1_200_000,
						tokensOut: 300_000,
						tokensCacheRead: 9_000_000,
						tokensCacheWrite: 0,
						costUsd: 0,
						calls: 40,
						subscription: true,
					},
				],
				runStates: [{ state: 'completed', count: 12 }],
				tools: {
					calls: 30,
					failed: 2,
					costUsd: 0,
					previousCostUsd: 0,
					top: [{ toolName: 'Read', calls: 20, failed: 0, costUsd: 0 }],
				},
				inbox: [{ severity: 'warning', count: 2 }],
			}),
		)
		const markdown = renderDigestMarkdown(digest)

		expect(markdown).toMatch(/^## Usage digest: last 7 days\n2026-09-16 12:00 to 2026-09-23 12:00 UTC\n/)
		expect(markdown).toContain('### Needs a look')
		expect(markdown).toContain('1.5M tokens used, up from 100.0K the previous 7 days.')
		expect(markdown).toContain('- **Runs:** 12 (0 failed, 0% failure rate)')
		expect(markdown).toContain('- **Tokens:** 1.2M in, 300.0K out, 9.0M cache read')
		expect(markdown).toContain('- **Metered spend:** $0.00 (Claude subscription runs are logged at $0)')
		expect(markdown).toContain('- **Tool calls:** 30 (2 failed)')
		expect(markdown).toContain('- **Review inbox:** 2 open (0 critical, 2 warning)')
		expect(markdown).toContain('- **Top models:** claude-sonnet-5 1.5M')
		expect(markdown).toContain('- **Most-used tools:** Read 20')
		expect(markdown.indexOf('**Tokens:**')).toBeLessThan(markdown.indexOf('**Metered spend:**'))
	})

	test('a quiet window says so, and a busy one caps the list well under the inbox limit', () => {
		expect(renderDigestMarkdown(assembleUsageDigest(baseInput()))).toContain('Nothing unusual.')

		const many = Array.from({ length: DIGEST_MARKDOWN_MAX_ANOMALIES + 4 }, (_, i) =>
			automation({ automationId: `a${i}`, description: `${'x'.repeat(150)} ${i}`, failed: 1 }),
		)
		const markdown = renderDigestMarkdown(assembleUsageDigest(baseInput({ automations: many })))
		expect(markdown).toContain('- …and 4 more.')
		// The review inbox keeps the first 4,000 characters of a maintenance summary.
		expect(markdown.length).toBeLessThan(4000)
		// Names are cut to one line, so a long description cannot swamp the digest.
		expect(markdown).not.toContain('x'.repeat(100))
	})
})
