import { expect, test } from '@playwright/test'
import { applySlotOverrides, type ContextSlot, type SlotOverride } from '../src/lib/context/slots.server'

test.describe('context/slot-overrides — applySlotOverrides', () => {
	const baseSlots: ContextSlot[] = [
		{ name: 'identity', priority: 100, content: 'You are an assistant' },
		{ name: 'tool_policy', priority: 90, content: 'Use tools politely' },
		{ name: 'skills', priority: 70, content: 'Skills list', truncationStrategy: 'truncate-end' },
		{ name: 'memory', priority: 60, content: 'Memory recall' },
	]

	test('returns slots unchanged when overrides map is empty', () => {
		const out = applySlotOverrides(baseSlots, {})
		expect(out.map((s) => s.name)).toEqual(['identity', 'tool_policy', 'skills', 'memory'])
		expect(out[0].priority).toBe(100)
	})

	test('disables a slot when override.enabled is false', () => {
		const out = applySlotOverrides(baseSlots, { memory: { enabled: false } })
		expect(out.map((s) => s.name)).toEqual(['identity', 'tool_policy', 'skills'])
	})

	test('overrides priority when set', () => {
		const out = applySlotOverrides(baseSlots, { memory: { priority: 200 } })
		const memory = out.find((s) => s.name === 'memory')
		expect(memory?.priority).toBe(200)
	})

	test('overrides tokenBudget when set to a positive number', () => {
		const out = applySlotOverrides(baseSlots, { skills: { tokenBudget: 50 } })
		const skills = out.find((s) => s.name === 'skills')
		expect(skills?.tokenBudget).toBe(50)
	})

	test('ignores tokenBudget when zero or negative (uses default)', () => {
		const out = applySlotOverrides(baseSlots, { skills: { tokenBudget: 0 } })
		const skills = out.find((s) => s.name === 'skills')
		expect(skills?.tokenBudget).toBeUndefined()
	})

	test('null tokenBudget / null priority preserve the slot defaults', () => {
		const o: SlotOverride = { tokenBudget: null, priority: null, enabled: true }
		const out = applySlotOverrides(baseSlots, { identity: o })
		const identity = out.find((s) => s.name === 'identity')
		expect(identity?.priority).toBe(100)
		expect(identity?.tokenBudget).toBeUndefined()
	})

	test('multiple overrides apply independently in one call', () => {
		const out = applySlotOverrides(baseSlots, {
			memory: { enabled: false },
			skills: { priority: 999 },
			identity: { tokenBudget: 200 },
		})
		expect(out.find((s) => s.name === 'memory')).toBeUndefined()
		expect(out.find((s) => s.name === 'skills')?.priority).toBe(999)
		expect(out.find((s) => s.name === 'identity')?.tokenBudget).toBe(200)
		// Untouched slots stay intact
		expect(out.find((s) => s.name === 'tool_policy')?.priority).toBe(90)
	})
})
