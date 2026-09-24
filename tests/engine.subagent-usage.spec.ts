import { expect, test } from '@playwright/test'
import { createSubagentUsageTally, spendTokenTotal } from '../src/lib/engine/subagent-usage'

/**
 * #32 — what a delegated child spent, added up over its model calls
 * (`src/lib/engine/subagent-usage.ts`), instead of the one final call the SDK's typed
 * result reports.
 */

const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0) => ({
	input_tokens: input,
	output_tokens: output,
	cache_creation_input_tokens: cacheWrite,
	cache_read_input_tokens: cacheRead,
})

const message = (id: string | null, u: unknown, model = 'claude-haiku-4-5') => ({
	...(id ? { id } : {}),
	model,
	usage: u,
	content: [],
})

test.describe('adding up a child', () => {
	test('every call counts once, however many messages it was split into', () => {
		const tally = createSubagentUsageTally()
		// Call 1 wrote text and a tool call: two messages, one id. The first went out before
		// the call's output count was final.
		tally.recordMessage('a1', message('msg_1', usage(100, 1, 50, 1_000)))
		tally.recordMessage('a1', message('msg_1', usage(100, 40, 50, 1_000)))
		// Call 2.
		const spend = tally.recordMessage('a1', message('msg_2', usage(30, 20, 0, 1_150)))
		expect(spend).toEqual({
			inputTokens: 130,
			outputTokens: 60,
			cacheCreationTokens: 50,
			cacheReadTokens: 2_150,
			modelCalls: 2,
			model: 'claude-haiku-4-5',
		})
	})

	test('a later, smaller report of the same call never lowers it', () => {
		const tally = createSubagentUsageTally()
		tally.recordMessage('a1', message('msg_1', usage(100, 40)))
		expect(tally.recordMessage('a1', message('msg_1', usage(100, 1)))?.outputTokens).toBe(40)
	})

	test('children are kept apart', () => {
		const tally = createSubagentUsageTally()
		tally.recordMessage('a1', message('msg_1', usage(100, 40)))
		tally.recordMessage('a2', message('msg_9', usage(7, 3)))
		expect(tally.totals('a1')?.inputTokens).toBe(100)
		expect(tally.totals('a2')?.inputTokens).toBe(7)
		expect(tally.totals('a3')).toBeNull()
	})

	test('a message without usage counts nothing, and one without an id counts on its own', () => {
		const tally = createSubagentUsageTally()
		expect(tally.recordMessage('a1', { id: 'msg_1', content: [] })).toBeNull()
		expect(tally.recordMessage('a1', 'garbage')).toBeNull()
		tally.recordMessage('a1', message(null, usage(10, 1)))
		expect(tally.recordMessage('a1', message(null, usage(10, 1)))?.modelCalls).toBe(2)
	})

	test('stream events: the start gives the call its id and input, the delta its final output', () => {
		const tally = createSubagentUsageTally()
		tally.recordStreamEvent('a1', { type: 'message_start', message: { id: 'msg_1', model: 'm', usage: usage(100, 1, 0, 500) } })
		const spend = tally.recordStreamEvent('a1', { type: 'message_delta', usage: { output_tokens: 250 } })
		expect(spend).toMatchObject({ inputTokens: 100, outputTokens: 250, cacheReadTokens: 500, modelCalls: 1 })
		// The whole message for the same call, arriving with its provisional count, changes nothing.
		expect(tally.recordMessage('a1', message('msg_1', usage(100, 1, 0, 500)))).toMatchObject({
			outputTokens: 250,
			modelCalls: 1,
		})
		// A delta with no start to belong to is not a call.
		expect(createSubagentUsageTally().recordStreamEvent('a2', { type: 'message_delta', usage: { output_tokens: 5 } })).toBeNull()
	})

	test("the typed result's figure is the last call's, exactly, and raises it to at least that", () => {
		const tally = createSubagentUsageTally()
		tally.recordMessage('a1', message('msg_1', usage(100, 40)))
		tally.recordMessage('a1', message('msg_2', usage(200, 1)))
		const spend = tally.recordFinalCall('a1', { inputTokens: 200, outputTokens: 90, cacheCreationTokens: 0, cacheReadTokens: 0 })
		expect(spend).toMatchObject({ inputTokens: 300, outputTokens: 130, modelCalls: 2 })
	})

	test('with nothing seen in the stream, the typed result is the whole figure', () => {
		const tally = createSubagentUsageTally()
		expect(tally.recordFinalCall('a1', { inputTokens: 5, outputTokens: 6, cacheCreationTokens: 0, cacheReadTokens: 7 })).toEqual({
			inputTokens: 5,
			outputTokens: 6,
			cacheCreationTokens: 0,
			cacheReadTokens: 7,
			modelCalls: 1,
			model: null,
		})
		expect(tally.recordFinalCall('a2', null)).toBeNull()
	})

	test("a card's token count is every token the calls used", () => {
		expect(spendTokenTotal({ inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 })).toBe(10)
		expect(spendTokenTotal({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })).toBeNull()
		expect(spendTokenTotal(null)).toBeNull()
	})
})
