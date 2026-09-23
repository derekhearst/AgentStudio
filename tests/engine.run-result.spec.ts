import { expect, test } from '@playwright/test'
import {
	parseSessionUsage,
	readTurnUsage,
	resultErrorMessage,
	type SessionUsage,
} from '../src/lib/engine/run-result'
import { runEngineStream, type EngineQuerySource } from '../src/lib/engine/stream.server'

/**
 * Reading the SDK's `result` message (`run-result.ts`), and the engine loop reporting it.
 *
 * Pins three things the loop used to get wrong:
 *   - usage came from `result.usage`, the main agent loop only, so a delegated `Task`
 *     child's tokens and the compaction calls vanished from the run's accounting (#107);
 *   - the SDK's running totals were logged as if they were the turn's, so every resumed turn
 *     re-counted every earlier one — the gateway ledger and budget limits included (#106);
 *   - an error result's reason sits in `errors[]`, which was never read, so every failure
 *     said "Run failed" (#108).
 */

const SESSION = 'session-1'

/** A result as the SDK sends it: per-model running totals, plus the main loop's own usage. */
function result(overrides: Record<string, unknown> = {}) {
	return {
		type: 'result',
		subtype: 'success',
		is_error: false,
		session_id: SESSION,
		duration_ms: 1,
		num_turns: 1,
		// The parent's own calls.
		usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
		// Everything: the parent's calls plus a subagent on a second model.
		modelUsage: {
			'claude-sonnet-5': {
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationInputTokens: 10,
				cacheReadInputTokens: 20,
				costUSD: 0.01,
			},
			'claude-haiku-5': {
				inputTokens: 3_000,
				outputTokens: 700,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 400,
				costUSD: 0.02,
			},
		},
		total_cost_usd: 0.03,
		...overrides,
	}
}

const baseline = (overrides: Partial<SessionUsage> = {}): SessionUsage => ({
	sessionId: SESSION,
	inputTokens: 1_000,
	outputTokens: 200,
	cacheCreationTokens: 5,
	cacheReadTokens: 100,
	costUsd: 0.01,
	...overrides,
})

test.describe('readTurnUsage — what a turn spent', () => {
	test('a fresh session counts every model, the subagent included', () => {
		const { usage, session } = readTurnUsage(result(), { resumed: false, baseline: null })

		// Not the parent's 100 / 50: the child's 3,000 / 700 are this run's work too.
		expect(usage).toEqual({
			inputTokens: 3_100,
			outputTokens: 750,
			cacheCreationTokens: 10,
			cacheReadTokens: 420,
			costUsd: 0.03,
		})
		expect(session).toEqual({ sessionId: SESSION, ...usage, costUsd: 0.03 })
	})

	test('a resumed turn logs its own share, not the session total again', () => {
		const { usage, session } = readTurnUsage(result(), { resumed: true, baseline: baseline() })

		expect(usage.inputTokens).toBe(2_100)
		expect(usage.outputTokens).toBe(550)
		expect(usage.cacheCreationTokens).toBe(5)
		expect(usage.cacheReadTokens).toBe(320)
		expect(usage.costUsd).toBeCloseTo(0.02, 10)
		// The running total is what the next turn subtracts.
		expect(session?.costUsd).toBe(0.03)
	})

	test('three turns at a dime each log three dimes, not 0.1 + 0.2 + 0.3', () => {
		let previous: SessionUsage | null = null
		const logged: number[] = []
		for (const total of [0.1, 0.2, 0.3]) {
			const { usage, session } = readTurnUsage(result({ total_cost_usd: total }), {
				resumed: previous !== null,
				baseline: previous,
			})
			logged.push(usage.costUsd ?? Number.NaN)
			previous = session
		}
		expect(logged.map((c) => Math.round(c * 100) / 100)).toEqual([0.1, 0.1, 0.1])
	})

	test('a baseline from another session is ignored', () => {
		// A resumed run with nothing to subtract falls back to the main loop's own figures and
		// leaves the price to the caller, rather than logging a total with earlier turns in it.
		const { usage } = readTurnUsage(result(), { resumed: true, baseline: baseline({ sessionId: 'other' }) })
		expect(usage).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheCreationTokens: 10,
			cacheReadTokens: 20,
			costUsd: null,
		})
	})

	test('a resumed session with no stored baseline does not re-count the session', () => {
		const { usage, session } = readTurnUsage(result(), { resumed: true, baseline: null })
		expect(usage.inputTokens).toBe(100)
		expect(usage.costUsd).toBeNull()
		// Still recorded, so the turn after this one has a baseline.
		expect(session?.inputTokens).toBe(3_100)
	})

	test('a running total that went down restarted, and is this turn alone', () => {
		const { usage } = readTurnUsage(result(), {
			resumed: true,
			baseline: baseline({ inputTokens: 50_000, costUsd: 5 }),
		})
		expect(usage.inputTokens).toBe(3_100)
		expect(usage.costUsd).toBe(0.03)
	})

	test('a producer with no modelUsage falls back to the main loop', () => {
		const { usage, session } = readTurnUsage(result({ modelUsage: undefined }), { resumed: false, baseline: null })
		expect(session).toBeNull()
		expect(usage.inputTokens).toBe(100)
		expect(usage.costUsd).toBe(0.03)
	})
})

test.describe('parseSessionUsage', () => {
	test('round-trips what the engine produces and rejects anything else', () => {
		const stored = baseline()
		expect(parseSessionUsage(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
		expect(parseSessionUsage(null)).toBeNull()
		expect(parseSessionUsage({ ...stored, sessionId: '' })).toBeNull()
		expect(parseSessionUsage({ ...stored, costUsd: '0.01' })).toBeNull()
	})
})

test.describe('resultErrorMessage — why a turn failed', () => {
	test('an error subtype reports its errors, not "Run failed"', () => {
		expect(
			resultErrorMessage({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				errors: ['bwrap: setting up uid map: Permission denied', ''],
			}),
		).toBe('bwrap: setting up uid map: Permission denied')
	})

	test('an error subtype with no text says what the subtype means', () => {
		expect(resultErrorMessage({ subtype: 'error_max_turns', is_error: true, errors: [] })).toBe(
			'Stopped after reaching the maximum number of turns.',
		)
	})

	test('a success-subtype API error keeps its result text', () => {
		expect(resultErrorMessage({ subtype: 'success', is_error: true, result: 'API Error: 401' })).toBe('API Error: 401')
	})

	test('a successful result is not an error, and an unknown one still says something', () => {
		expect(resultErrorMessage({ subtype: 'success', is_error: false, result: 'fine' })).toBeNull()
		expect(resultErrorMessage({ subtype: 'something_new', is_error: true })).toBe('Run failed')
	})
})

test.describe('the engine loop', () => {
	function scripted(messages: unknown[]): EngineQuerySource {
		return {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message as never
			},
		}
	}

	test('reports the turn usage, the running total and the error reason', async () => {
		const summary = await runEngineStream({
			prompt: 'go',
			options: { resume: SESSION },
			usageBaseline: baseline(),
			createQuery: () =>
				scripted([
					result({
						subtype: 'error_max_turns',
						is_error: true,
						errors: ['Reached maximum number of turns (64)'],
					}),
				]),
			requiresApproval: () => false,
			emit: async () => {},
		})

		expect(summary.usage.inputTokens).toBe(2_100)
		expect(summary.sessionUsage?.inputTokens).toBe(3_100)
		expect(summary.error).toBe('Reached maximum number of turns (64)')
	})
})
