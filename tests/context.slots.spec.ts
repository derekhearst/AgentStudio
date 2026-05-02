import { expect, test } from '@playwright/test'
import { assembleSystemPrompt, type ContextSlot } from '../src/lib/context/slots.server'

test.describe('context/slots — assembleSystemPrompt', () => {
	test('concatenates slots in insertion order with no budget pressure', () => {
		const slots: ContextSlot[] = [
			{ name: 'identity', priority: 100, content: 'You are an assistant.' },
			{ name: 'tool_policy', priority: 90, content: 'Always be polite.' },
			{ name: 'skills', priority: 70, content: 'Available: search.' },
		]
		const result = assembleSystemPrompt(slots)
		expect(result.systemPrompt).toBe(['You are an assistant.', 'Always be polite.', 'Available: search.'].join('\n\n'))
		expect(result.includedSlots).toEqual(['identity', 'tool_policy', 'skills'])
		expect(result.droppedSlots).toEqual([])
		expect(result.truncatedSlots).toEqual([])
	})

	test('drops empty/whitespace slots silently without listing them', () => {
		const result = assembleSystemPrompt([
			{ name: 'identity', priority: 100, content: 'You are real.' },
			{ name: 'memory', priority: 60, content: '   ' },
			{ name: 'skills', priority: 70, content: '' },
		])
		expect(result.systemPrompt).toBe('You are real.')
		expect(result.includedSlots).toEqual(['identity'])
		expect(result.droppedSlots).toEqual([])
	})

	test('drops lowest-priority slots first when budget is exceeded', () => {
		const big = 'x'.repeat(2000) // ~500 tokens at chars/4
		const slots: ContextSlot[] = [
			{ name: 'identity', priority: 100, content: big },
			{ name: 'tool_policy', priority: 90, content: big },
			{ name: 'skills', priority: 70, content: big },
			{ name: 'memory', priority: 60, content: big },
		]
		const result = assembleSystemPrompt(slots, 600)
		// Highest-priority slots survive; lowest-priority get dropped.
		expect(result.includedSlots).toContain('identity')
		expect(result.droppedSlots).toContain('memory')
		expect(result.estimatedTokens).toBeLessThanOrEqual(600 + 1) // +1 for separator rounding
	})

	test('truncates slots with truncate-end strategy before dropping them', () => {
		const big = 'x'.repeat(4000) // ~1000 tokens
		const slots: ContextSlot[] = [
			{ name: 'identity', priority: 100, content: 'Short.' },
			{
				name: 'memory',
				priority: 60,
				content: big,
				truncationStrategy: 'truncate-end',
				tokenBudget: 200,
			},
		]
		const result = assembleSystemPrompt(slots, 250)
		expect(result.includedSlots).toContain('identity')
		expect(result.includedSlots).toContain('memory')
		expect(result.truncatedSlots).toContain('memory')
		expect(result.droppedSlots).not.toContain('memory')
		expect(result.systemPrompt).toContain('[...truncated]')
	})

	test('returns empty result when given no slots', () => {
		const result = assembleSystemPrompt([])
		expect(result.systemPrompt).toBe('')
		expect(result.includedSlots).toEqual([])
		expect(result.droppedSlots).toEqual([])
		expect(result.estimatedTokens).toBe(0)
	})

	test('preserves insertion order even when priorities are not monotonic', () => {
		// User pushes skills (p70) before tool_policy (p90); insertion order wins for layout.
		const result = assembleSystemPrompt([
			{ name: 'identity', priority: 100, content: 'A' },
			{ name: 'skills', priority: 70, content: 'B' },
			{ name: 'tool_policy', priority: 90, content: 'C' },
		])
		expect(result.systemPrompt).toBe(['A', 'B', 'C'].join('\n\n'))
		expect(result.includedSlots).toEqual(['identity', 'skills', 'tool_policy'])
	})

	test('respects insertion order when slots fit but priority decides drops under pressure', () => {
		const filler = 'y'.repeat(800) // ~200 tokens each
		const slots: ContextSlot[] = [
			{ name: 'a', priority: 50, content: filler },
			{ name: 'b', priority: 100, content: filler },
			{ name: 'c', priority: 75, content: filler },
		]
		const result = assembleSystemPrompt(slots, 250) // only one ~200-token slot fits
		expect(result.includedSlots).toEqual(['b']) // highest priority wins
		expect(result.droppedSlots.sort()).toEqual(['a', 'c'])
	})
})
