import { expect, test } from '@playwright/test'
import { findSafeSplitPoint, type CompactableMessage } from '../src/lib/chat/compaction'

type LlmMessage = CompactableMessage

function user(content: string): LlmMessage {
	return { role: 'user', content }
}
function assistant(content: string, toolCalls?: LlmMessage['toolCalls']): LlmMessage {
	return { role: 'assistant', content, toolCalls }
}
function tool(content: string, toolCallId: string): LlmMessage {
	return { role: 'tool', content, toolCallId }
}

const callA = { id: 'A', type: 'function', function: { name: 'shell', arguments: '{}' } } as const
const callB = { id: 'B', type: 'function', function: { name: 'web_search', arguments: '{}' } } as const

test.describe('chat/compaction — findSafeSplitPoint preserves tool call/result pairs', () => {
	test('clean split between user and assistant text turns is left untouched', () => {
		const m: LlmMessage[] = [
			user('q1'),
			assistant('r1'),
			user('q2'),
			assistant('r2'),
			user('q3'),
			assistant('r3'),
		]
		expect(findSafeSplitPoint(m, 2)).toBe(2)
		expect(findSafeSplitPoint(m, 4)).toBe(4)
	})

	test('a split that lands ON a tool result moves up to include the assistant tool_call', () => {
		// indices: 0=user, 1=assistant(callA), 2=tool(A), 3=user, 4=assistant
		const m: LlmMessage[] = [
			user('please do X'),
			assistant('', [callA]),
			tool('result of A', 'A'),
			user('thanks'),
			assistant('done'),
		]
		// Initial split=2 lands on tool(A). The safe split moves recent to start at the assistant
		// (index 1), so the tool-call/tool-result pair stays together in recent.
		expect(findSafeSplitPoint(m, 2)).toBe(1)
	})

	test('a split right after an assistant with toolCalls moves up to include that assistant', () => {
		const m: LlmMessage[] = [
			user('q'),
			assistant('', [callA]),
			tool('rA', 'A'),
			user('next'),
			assistant('done'),
		]
		expect(findSafeSplitPoint(m, 2)).toBe(1)
	})

	test('multiple tool results in a row are kept together with their parent assistant', () => {
		// indices: 0=user, 1=assistant(callA, callB), 2=tool(A), 3=tool(B), 4=user, 5=assistant
		const m: LlmMessage[] = [
			user('q'),
			assistant('', [callA, callB]),
			tool('rA', 'A'),
			tool('rB', 'B'),
			user('thanks'),
			assistant('done'),
		]
		// Mid-pair splits should land on the assistant tool-call (1) so the whole pair stays in recent.
		expect(findSafeSplitPoint(m, 2)).toBe(1)
		expect(findSafeSplitPoint(m, 3)).toBe(1)
		// After the pair completes, the boundary is safe.
		expect(findSafeSplitPoint(m, 4)).toBe(4)
		expect(findSafeSplitPoint(m, 5)).toBe(5)
	})

	test('split that lands between completed tool sequence and a fresh user turn is preserved', () => {
		const m: LlmMessage[] = [
			user('first'),
			assistant('', [callA]),
			tool('rA', 'A'),
			user('second'),
			assistant('', [callB]),
			tool('rB', 'B'),
			user('third'),
			assistant('done'),
		]
		// split=3 (recent starts at user 'second') is safe — early ends with completed tool pair.
		expect(findSafeSplitPoint(m, 3)).toBe(3)
		expect(findSafeSplitPoint(m, 6)).toBe(6) // recent starts at user 'third'
	})

	test('walks past short tool sequences so the caller can decide compaction is unworthwhile', () => {
		// All three messages tied together as one tool turn: user, assistant(callA), tool(A).
		// Boundary should land at 1 (recent = [assistant, tool]) so the pair is preserved.
		// The caller (compactMessages) checks earlyMessages.length < 4 and skips compaction.
		const m: LlmMessage[] = [user('q'), assistant('', [callA]), tool('rA', 'A')]
		expect(findSafeSplitPoint(m, 2)).toBe(1)
		expect(findSafeSplitPoint(m, 1)).toBe(1)
	})

	test('handles edge cases without throwing', () => {
		expect(findSafeSplitPoint([], 0)).toBe(0)
		expect(findSafeSplitPoint([], 5)).toBe(0)
		expect(findSafeSplitPoint([user('only')], 1)).toBe(1)
		expect(findSafeSplitPoint([user('only')], 5)).toBe(1)
	})

	test('a long history with a mid-sequence tool pair has the split moved past the pair', () => {
		// Initial desired split would land mid-sequence; safe split should land before the assistant tool call.
		const m: LlmMessage[] = [
			user('q1'),
			assistant('r1'),
			user('q2'),
			assistant('', [callA]),
			tool('rA', 'A'),
			user('q3'),
			assistant('done'),
		]
		// desired split = 4 (recent starts at tool). Should move to 3 (assistant tool call) or earlier.
		const split = findSafeSplitPoint(m, 4)
		expect(split).toBeLessThanOrEqual(3)
		// Verify the resulting recent slice is consistent: never starts with a tool message,
		// and the message immediately before it is never an assistant with toolCalls.
		const recent = m.slice(split)
		const lastEarly = m[split - 1]
		expect(recent[0]?.role !== 'tool').toBe(true)
		expect(
			!(lastEarly?.role === 'assistant' && Array.isArray(lastEarly.toolCalls) && lastEarly.toolCalls.length > 0),
		).toBe(true)
	})
})
