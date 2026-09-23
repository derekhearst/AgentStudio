import { expect, test } from '@playwright/test'
import { computeContextMetrics } from '../src/lib/chat/context-metrics'

/**
 * #78 — the context meter read only the system prompt from the first turn on.
 *
 * The stream's `context_stats` frame reports the assembled system prompt's size. The meter
 * took it as the whole context and let it replace the history estimate, so a long
 * conversation read as a few thousand tokens after one message — and the model-switch
 * auto-compact, which compares this figure to the smaller model's window, never fired.
 */

const LONG_REPLY = 'x'.repeat(400_000) // ~100K tokens at chars/4

function metrics(systemPromptTokens: number | null) {
	return computeContextMetrics({
		displayedMessages: [
			{ id: 'u1', role: 'user', content: 'build it' },
			{
				id: 'a1',
				role: 'assistant',
				content: LONG_REPLY,
				toolCalls: [],
				// An Agent SDK turn saves its calls on the blocks, with `toolCalls` left empty.
				metadata: { blocks: [{ kind: 'tool', name: 'Bash', result: 'y'.repeat(200_000) }] },
			},
		],
		stats: [],
		messages: [],
		totalBudget: 200_000,
		systemPromptTokens,
	})
}

test('the reported system prompt is one part of the figure, not all of it', () => {
	const cold = metrics(null)
	const afterATurn = metrics(3_200)

	// History (~100K) and the saved tool output (~50K) count either way.
	expect(cold.used).toBeGreaterThan(150_000)
	expect(afterATurn.used).toBeGreaterThan(150_000)
	// The measured system prompt replaces only the floor that stood in for it.
	expect(afterATurn.used - cold.used).toBe(3_200 - 900)
	expect(afterATurn.breakdown.system).toBe(1.6)
})

test('tool output saved on a reply counts as context', () => {
	const withBlocks = metrics(null)
	const withoutBlocks = computeContextMetrics({
		displayedMessages: [
			{ id: 'u1', role: 'user', content: 'build it' },
			{ id: 'a1', role: 'assistant', content: LONG_REPLY, toolCalls: [] },
		],
		stats: [],
		messages: [],
		totalBudget: 200_000,
		systemPromptTokens: null,
	})
	expect(withBlocks.used - withoutBlocks.used).toBe(50_000)
	expect(withBlocks.breakdown.results).toBe(25)
})

test('a stopped reply saved with its tool output twice counts it once', () => {
	// `persistPartialIfIncomplete` saves a Stop or error partial with the finished calls on
	// `toolCalls` and the same results on `metadata.blocks`.
	const output = 'y'.repeat(200_000) // ~50K tokens
	const base = {
		stats: [],
		messages: [],
		totalBudget: 1_000_000,
		systemPromptTokens: null,
	}
	const both = computeContextMetrics({
		...base,
		displayedMessages: [
			{
				id: 'a1',
				role: 'assistant',
				content: '',
				toolCalls: [{ result: output }],
				metadata: { blocks: [{ kind: 'text', text: '' }, { kind: 'tool', name: 'Bash', result: output }] },
			},
		],
	})
	const callsOnly = computeContextMetrics({
		...base,
		displayedMessages: [{ id: 'a1', role: 'assistant', content: '', toolCalls: [{ result: output }] }],
	})
	// Blocks with no tool call leave the reply's `toolCalls` as the source.
	const textBlocksOnly = computeContextMetrics({
		...base,
		displayedMessages: [
			{
				id: 'a1',
				role: 'assistant',
				content: '',
				toolCalls: [{ result: output }],
				metadata: { blocks: [{ kind: 'text', text: '' }] },
			},
		],
	})

	expect(both.breakdown.results).toBe(5)
	expect(both.used).toBe(callsOnly.used)
	expect(textBlocksOnly.used).toBe(callsOnly.used)
})
