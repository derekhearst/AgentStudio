import { expect, test } from '@playwright/test'
import {
	buildHistoryPreamble,
	buildUnansweredPreamble,
	hasPendingCut,
	isSlashCommand,
	readTailUuid,
	readTurnJoin,
	resolveTurnResume,
	supportsFileCheckpoints,
	turnPromptContent,
	unansweredTail,
} from '../src/lib/chat/turn-plan'

/**
 * The join between `messages` rows and the SDK transcript, and the decision it feeds: how an
 * edited or regenerated turn starts its session so the model sees exactly the kept history
 * plus the row's own text. Pure; the database half is `chat.regenerate-fork.spec.ts`.
 */

function uuids() {
	let n = 0
	return () => `uuid-${++n}`
}

test.describe('resolveTurnResume', () => {
	test('a new message resumes the session as it is', () => {
		const plan = resolveTurnResume({
			cut: false,
			sdkSessionId: 's1',
			previousAssistant: null,
			keptHistory: [],
			mintUuid: uuids(),
		})
		expect(plan.first).toEqual({ kind: 'continue', resumeSessionId: 's1', preamble: null, sdkUserUuid: 'uuid-1' })
		expect(plan.fallback).toBeNull()
	})

	test('the first message of a conversation starts a session', () => {
		const plan = resolveTurnResume({
			cut: false,
			sdkSessionId: null,
			previousAssistant: null,
			keptHistory: [],
			mintUuid: uuids(),
		})
		expect(plan.first.kind).toBe('continue')
		expect(plan.first).not.toHaveProperty('resumeSessionId')
	})

	test('a regenerate cuts the session after the previous reply, with a fresh session as the fallback', () => {
		const plan = resolveTurnResume({
			cut: true,
			sdkSessionId: 's1',
			previousAssistant: { sdkSessionId: 's1', sdkTailUuid: 'tail-1' },
			keptHistory: [
				{ role: 'user', content: 'What is 2+2?' },
				{ role: 'assistant', content: '4' },
			],
			mintUuid: uuids(),
		})
		expect(plan.first).toEqual({
			kind: 'fork',
			resumeSessionId: 's1',
			resumeSessionAt: 'tail-1',
			preamble: null,
			sdkUserUuid: 'uuid-1',
		})
		expect(plan.fallback?.kind).toBe('fresh')
		expect(plan.fallback?.preamble).toContain('User: What is 2+2?')
		expect(plan.fallback?.preamble).toContain('Assistant: 4')
		// Never the same uuid twice: the refused attempt may have left its own in the transcript.
		expect(plan.fallback?.sdkUserUuid).not.toBe(plan.first.sdkUserUuid)
	})

	test('regenerating the first message starts a fresh session with nothing to carry', () => {
		const plan = resolveTurnResume({
			cut: true,
			sdkSessionId: 's1',
			previousAssistant: null,
			keptHistory: [],
			mintUuid: uuids(),
		})
		expect(plan.first).toEqual({ kind: 'fresh', preamble: null, sdkUserUuid: 'uuid-1' })
		expect(plan.fallback).toBeNull()
	})

	test('a previous reply without a tail — older than the join — gets the history as text', () => {
		const plan = resolveTurnResume({
			cut: true,
			sdkSessionId: 's1',
			previousAssistant: { sdkSessionId: 's1', sdkTailUuid: null },
			keptHistory: [
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'reply' },
			],
			mintUuid: uuids(),
		})
		expect(plan.first.kind).toBe('fresh')
		expect(plan.first.preamble).toContain('User: first')
		expect(plan.fallback).toBeNull()
	})

	test('a cut puts the user rows the kept session never answered in front of the text', () => {
		const keptHistory = [
			{ role: 'user', content: 'What is 2+2?' },
			{ role: 'assistant', content: '4' },
			{ role: 'user', content: 'What is 3+3?' },
		]
		const plan = resolveTurnResume({
			cut: true,
			sdkSessionId: 's1',
			previousAssistant: { sdkSessionId: 's1', sdkTailUuid: 'tail-1' },
			keptHistory,
			unanswered: unansweredTail(keptHistory),
			mintUuid: uuids(),
		})
		expect(plan.first).toMatchObject({ kind: 'fork', resumeSessionId: 's1', resumeSessionAt: 'tail-1' })
		expect(plan.first.preamble).toContain('User: What is 3+3?')
		expect(plan.first.preamble).not.toContain('2+2')
		// The fresh fallback carries the whole kept history, the unanswered row included.
		expect(plan.fallback?.preamble).toContain('User: What is 2+2?')
		expect(plan.fallback?.preamble).toContain('User: What is 3+3?')
	})

	test('a tail from an earlier session is not a place to cut this one', () => {
		const plan = resolveTurnResume({
			cut: true,
			sdkSessionId: 's2',
			previousAssistant: { sdkSessionId: 's1', sdkTailUuid: 'tail-in-s1' },
			keptHistory: [{ role: 'user', content: 'first' }],
			mintUuid: uuids(),
		})
		expect(plan.first.kind).toBe('fresh')
	})
})

test.describe('buildHistoryPreamble', () => {
	test('is null when nothing is kept', () => {
		expect(buildHistoryPreamble([])).toBeNull()
		expect(buildHistoryPreamble([{ role: 'system', content: 'anchor' }, { role: 'user', content: '   ' }])).toBeNull()
	})

	test('keeps the most recent turns within the budget and says when it dropped some', () => {
		const rows = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(50)}` }))
		const preamble = buildHistoryPreamble(rows, 200)!
		expect(preamble).toContain('message 9')
		expect(preamble).not.toContain('message 0 ')
		expect(preamble).toContain('(Earlier messages omitted.)')
	})

	test('skips rows that are not the conversation', () => {
		const preamble = buildHistoryPreamble([
			{ role: 'system', content: 'agent switched' },
			{ role: 'user', content: 'hello' },
		])!
		expect(preamble).not.toContain('agent switched')
		expect(preamble).toContain('User: hello')
	})
})

test.describe('unanswered rows', () => {
	test('unansweredTail is the user rows after the last reply', () => {
		expect(unansweredTail([])).toEqual([])
		expect(
			unansweredTail([
				{ role: 'user', content: 'a' },
				{ role: 'assistant', content: 'b' },
			]),
		).toEqual([])
		expect(
			unansweredTail([
				{ role: 'user', content: 'a' },
				{ role: 'assistant', content: 'b' },
				{ role: 'user', content: 'c' },
				{ role: 'user', content: 'd' },
			]),
		).toEqual([
			{ role: 'user', content: 'c' },
			{ role: 'user', content: 'd' },
		])
		// No reply at all: every user row is unanswered.
		expect(unansweredTail([{ role: 'user', content: 'a' }])).toEqual([{ role: 'user', content: 'a' }])
	})

	test('buildUnansweredPreamble frames them as unanswered, and is null for none', () => {
		expect(buildUnansweredPreamble([])).toBeNull()
		const preamble = buildUnansweredPreamble([{ role: 'user', content: 'What is 3+3?' }])!
		expect(preamble).toContain('did not get a reply')
		expect(preamble).toContain('User: What is 3+3?')
		expect(preamble).toContain('The message to answer follows.')
	})

	test('isSlashCommand: nothing may go in front of a CLI command', () => {
		expect(isSlashCommand('/compact Preserve all requirements.')).toBe(true)
		expect(isSlashCommand('  /compact')).toBe(true)
		expect(isSlashCommand('a/b')).toBe(false)
		expect(isSlashCommand('/ not a command')).toBe(false)
		expect(isSlashCommand('')).toBe(false)
	})

	test('hasPendingCut reads the stamp an edit or regenerate leaves', () => {
		expect(hasPendingCut({ sdkCutPending: true })).toBe(true)
		expect(hasPendingCut({ sdkCutPending: 'yes' })).toBe(false)
		expect(hasPendingCut({})).toBe(false)
		expect(hasPendingCut(null)).toBe(false)
	})
})

test.describe('turnPromptContent', () => {
	test('text goes out as it is, or behind the preamble', () => {
		expect(turnPromptContent({ text: 'What is 3+3?', content: null }, null)).toBe('What is 3+3?')
		expect(turnPromptContent({ text: 'What is 3+3?', content: null }, 'HISTORY')).toBe('HISTORY\n\nWhat is 3+3?')
	})

	test('blocks stay blocks; the preamble joins the first text block', () => {
		const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
		const blocks = [{ type: 'text', text: 'look' }, image]
		expect(turnPromptContent({ text: 'look', content: blocks }, null)).toBe(blocks)
		const primed = turnPromptContent({ text: 'look', content: blocks }, 'HISTORY') as Array<Record<string, unknown>>
		expect(primed[0]).toEqual({ type: 'text', text: 'HISTORY\n\nlook' })
		expect(primed[1]).toBe(image)
		// The prepared prompt itself is not mutated.
		expect(blocks[0]).toEqual({ type: 'text', text: 'look' })
	})
})

test.describe('the join on metadata', () => {
	test('readTurnJoin reads a complete join and refuses a partial one', () => {
		expect(
			readTurnJoin({ sdkTurn: { uuid: 'u', sessionId: 's', cwd: '/w', checkpointed: true }, other: 1 }),
		).toEqual({ uuid: 'u', sessionId: 's', cwd: '/w', checkpointed: true })
		expect(readTurnJoin({ sdkTurn: { uuid: 'u', sessionId: 's', cwd: '/w' } })?.checkpointed).toBe(false)
		expect(readTurnJoin({ sdkTurn: { uuid: 'u', cwd: '/w' } })).toBeNull()
		expect(readTurnJoin({})).toBeNull()
		expect(readTurnJoin(null)).toBeNull()
	})

	test('readTailUuid reads the assistant row’s tail', () => {
		expect(readTailUuid({ sdkTailUuid: 't1' })).toBe('t1')
		expect(readTailUuid({ sdkTailUuid: '' })).toBeNull()
		expect(readTailUuid({})).toBeNull()
	})
})

test.describe('supportsFileCheckpoints', () => {
	test('only a workspace that outlives the turn is checkpointed', () => {
		expect(supportsFileCheckpoints({ projectId: 'p1' })).toBe(true)
		expect(supportsFileCheckpoints({ persistentKey: 'k' })).toBe(true)
		expect(supportsFileCheckpoints({ persistentKey: 'k', worktree: { repoPath: '/r' } })).toBe(true)
		expect(supportsFileCheckpoints({ projectId: 'p1', worktree: { repoPath: '/r' } })).toBe(false)
		expect(supportsFileCheckpoints({})).toBe(false)
	})
})
