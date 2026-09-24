import { expect, test } from '@playwright/test'
import {
	isResumeRefusal,
	nextTranscriptTail,
	runWithResumeFallback,
	userTurnMessages,
	withTurnResume,
	type TurnAttempt,
	type TurnAttemptPlan,
} from '../src/lib/engine/turn-input'
import { runEngineStream, type EngineQuerySource } from '../src/lib/engine/stream.server'

/**
 * How a chat turn enters its SDK session (#24 and the edit/regenerate fix): the prompt's
 * own uuid, the transcript tail a later edit cuts back to, and the fallback when the CLI
 * refuses the cut. Pure, apart from the last group, which drives the real engine loop over
 * a scripted stream the way `engine.stream-routing.spec.ts` does.
 */

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const item of iterable) out.push(item)
	return out
}

test.describe('userTurnMessages', () => {
	test('yields exactly one user message carrying the uuid we chose', async () => {
		const messages = await collect(userTurnMessages('hello', '11111111-1111-4111-8111-111111111111'))
		expect(messages).toHaveLength(1)
		expect(messages[0]).toMatchObject({
			type: 'user',
			parent_tool_use_id: null,
			uuid: '11111111-1111-4111-8111-111111111111',
			message: { role: 'user', content: 'hello' },
		})
	})

	test('keeps text as a plain string, so a slash command like /compact still reads as one', async () => {
		const [message] = await collect(userTurnMessages('/compact keep the plan', 'u'))
		expect(message.message.content).toBe('/compact keep the plan')
	})

	test('passes content blocks through untouched', async () => {
		const blocks = [
			{ type: 'text', text: 'look' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
		]
		const [message] = await collect(userTurnMessages(blocks, 'u'))
		expect(message.message.content).toEqual(blocks)
	})
})

test.describe('nextTranscriptTail', () => {
	test('follows the main thread’s assistant and user messages', () => {
		let tail: string | null = null
		tail = nextTranscriptTail(tail, { type: 'assistant', uuid: 'a1', parent_tool_use_id: null })
		expect(tail).toBe('a1')
		tail = nextTranscriptTail(tail, { type: 'user', uuid: 'tool-result-1', parent_tool_use_id: null })
		expect(tail).toBe('tool-result-1')
		tail = nextTranscriptTail(tail, { type: 'assistant', uuid: 'a2', parent_tool_use_id: null })
		expect(tail).toBe('a2')
	})

	test('ignores what is not a main-thread chain entry', () => {
		const tail = 'a1'
		expect(nextTranscriptTail(tail, { type: 'stream_event', uuid: 'se', parent_tool_use_id: null })).toBe('a1')
		expect(nextTranscriptTail(tail, { type: 'assistant', uuid: 'child', parent_tool_use_id: 'task-1' })).toBe('a1')
		expect(nextTranscriptTail(tail, { type: 'user', uuid: 'replay', isReplay: true, parent_tool_use_id: null })).toBe('a1')
		expect(nextTranscriptTail(tail, { type: 'result', uuid: 'r', subtype: 'success' })).toBe('a1')
		expect(nextTranscriptTail(tail, { type: 'system', subtype: 'init', uuid: 's' })).toBe('a1')
		expect(nextTranscriptTail(tail, { type: 'assistant', parent_tool_use_id: null })).toBe('a1')
	})

	test('a compaction boundary clears it, and the summary the CLI writes after it sets it again', () => {
		let tail: string | null = 'a1'
		tail = nextTranscriptTail(tail, { type: 'system', subtype: 'compact_boundary', uuid: 'b' })
		expect(tail).toBeNull()
		// What `/compact` streams after the boundary: the summary, as main-thread user entries.
		tail = nextTranscriptTail(tail, { type: 'user', uuid: 'summary', parent_tool_use_id: null })
		expect(tail).toBe('summary')
		tail = nextTranscriptTail(tail, { type: 'assistant', uuid: 'a2', parent_tool_use_id: null })
		expect(tail).toBe('a2')
	})
})

test.describe('withTurnResume', () => {
	const base = { model: 'claude-sonnet-5', resume: 'old', resumeSessionAt: 'old-tail', cwd: '/w' }

	test('a fork resumes and cuts', () => {
		const options = withTurnResume(base, {
			kind: 'fork',
			resumeSessionId: 's1',
			resumeSessionAt: 't1',
			preamble: null,
			sdkUserUuid: 'u',
		})
		expect(options).toMatchObject({ model: 'claude-sonnet-5', cwd: '/w', resume: 's1', resumeSessionAt: 't1' })
	})

	test('a fresh session drops both, so it cannot resume the session it replaces', () => {
		const options = withTurnResume(base, { kind: 'fresh', preamble: 'x', sdkUserUuid: 'u' })
		expect(options).not.toHaveProperty('resume')
		expect(options).not.toHaveProperty('resumeSessionAt')
		expect(options.cwd).toBe('/w')
	})

	test('a plain continue resumes without cutting', () => {
		const options = withTurnResume(base, { kind: 'continue', resumeSessionId: 's1', preamble: null, sdkUserUuid: 'u' })
		expect(options.resume).toBe('s1')
		expect(options).not.toHaveProperty('resumeSessionAt')
	})
})

test.describe('isResumeRefusal', () => {
	test('recognises the CLI’s own refusals', () => {
		expect(isResumeRefusal('No message found with message.uuid of: 3522cd6d-abd3')).toBe(true)
		expect(isResumeRefusal('Resume rejected by --resume-drops-turn: resuming at x would discard')).toBe(true)
		expect(isResumeRefusal('Failed to resume session: ENOENT')).toBe(true)
		expect(isResumeRefusal('No conversation found with session ID: abc')).toBe(true)
	})

	test('leaves every other failure alone', () => {
		expect(isResumeRefusal(null)).toBe(false)
		expect(isResumeRefusal('Reached maximum number of turns')).toBe(false)
		expect(isResumeRefusal('Overloaded')).toBe(false)
	})
})

test.describe('runWithResumeFallback', () => {
	const fork: TurnAttempt = { kind: 'fork', resumeSessionId: 's', resumeSessionAt: 't', preamble: null, sdkUserUuid: 'u1' }
	const fresh: TurnAttempt = { kind: 'fresh', preamble: 'history', sdkUserUuid: 'u2' }
	const plan: TurnAttemptPlan = { first: fork, fallback: fresh }
	const refused = { error: 'No message found with message.uuid of: t', text: '', blocks: [] as unknown[] }
	const ok = { error: null, text: 'answer', blocks: [{ kind: 'text' }] as unknown[] }

	test('a refused cut that produced nothing runs the fallback once', async () => {
		const attempts: TurnAttempt[] = []
		const reasons: string[] = []
		const outcome = await runWithResumeFallback(
			plan,
			async (attempt) => {
				attempts.push(attempt)
				return attempt.kind === 'fork' ? refused : ok
			},
			(reason) => reasons.push(reason),
		)
		expect(attempts.map((a) => a.kind)).toEqual(['fork', 'fresh'])
		expect(outcome).toBe(ok)
		expect(reasons[0]).toContain('No message found')
	})

	test('a refusal thrown by the SDK falls back the same way', async () => {
		const attempts: string[] = []
		const outcome = await runWithResumeFallback(plan, async (attempt) => {
			attempts.push(attempt.kind)
			if (attempt.kind === 'fork') throw new Error('Failed to resume session: gone')
			return ok
		})
		expect(attempts).toEqual(['fork', 'fresh'])
		expect(outcome).toBe(ok)
	})

	test('a notice-only first attempt still counts as having produced nothing', async () => {
		const attempts: string[] = []
		await runWithResumeFallback(plan, async (attempt) => {
			attempts.push(attempt.kind)
			return attempt.kind === 'fork' ? { ...refused, blocks: [{ kind: 'notice' }] } : ok
		})
		expect(attempts).toEqual(['fork', 'fresh'])
	})

	test('never repeats a turn that already did something', async () => {
		const attempts: string[] = []
		const partial = { error: 'No message found with message.uuid of: t', text: 'half an answer', blocks: [] }
		const outcome = await runWithResumeFallback(plan, async (attempt) => {
			attempts.push(attempt.kind)
			return partial
		})
		expect(attempts).toEqual(['fork'])
		expect(outcome).toBe(partial)
	})

	test('other failures and plans without a fallback are returned as they are', async () => {
		const failed = { error: 'Overloaded', text: '', blocks: [] }
		const attempts: string[] = []
		expect(await runWithResumeFallback(plan, async (a) => (attempts.push(a.kind), failed))).toBe(failed)
		expect(await runWithResumeFallback({ first: fork, fallback: null }, async (a) => (attempts.push(a.kind), refused))).toBe(
			refused,
		)
		await expect(
			runWithResumeFallback(plan, async () => {
				throw new Error('socket hang up')
			}),
		).rejects.toThrow('socket hang up')
		expect(attempts).toEqual(['fork', 'fork'])
	})
})

test.describe('runEngineStream reports the transcript tail', () => {
	function scripted(messages: unknown[]): EngineQuerySource {
		return {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message as never
			},
		}
	}

	test('sdkTailUuid is the last main-thread entry, whatever the subagents and stream events did', async () => {
		const summary = await runEngineStream({
			prompt: 'go',
			options: {},
			createQuery: () =>
				scripted([
					{ type: 'system', subtype: 'init', session_id: 's1', uuid: 'init' },
					{ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, session_id: 's1', message: { content: [] } },
					{ type: 'user', uuid: 'r1', parent_tool_use_id: null, session_id: 's1', message: { content: [] } },
					{ type: 'assistant', uuid: 'child', parent_tool_use_id: 'task-1', session_id: 's1', message: { content: [] } },
					{
						type: 'stream_event',
						uuid: 'se',
						parent_tool_use_id: null,
						session_id: 's1',
						event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
					},
					{ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, session_id: 's1', message: { content: [] } },
					{ type: 'result', uuid: 'res', session_id: 's1', usage: {}, duration_ms: 1, num_turns: 1 },
				]),
			requiresApproval: () => false,
			emit: async () => {},
		})
		expect(summary.sdkTailUuid).toBe('a2')
		expect(summary.sessionId).toBe('s1')
	})

	test('a /compact turn reports the summary after the boundary as its tail', async () => {
		const summary = await runEngineStream({
			prompt: '/compact',
			options: {},
			createQuery: () =>
				scripted([
					{ type: 'system', subtype: 'init', session_id: 's1', uuid: 'init' },
					{ type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { trigger: 'manual', pre_tokens: 10 } },
					{ type: 'user', uuid: 'summary-1', parent_tool_use_id: null, message: { role: 'user', content: 'summary' } },
					{ type: 'user', uuid: 'summary-2', parent_tool_use_id: null, message: { role: 'user', content: 'output' } },
					{ type: 'result', usage: {}, duration_ms: 1, num_turns: 1 },
				]),
			requiresApproval: () => false,
			emit: async () => {},
		})
		expect(summary.sdkTailUuid).toBe('summary-2')
	})

	test('a turn that ends in a compaction with nothing after it reports no tail', async () => {
		const summary = await runEngineStream({
			prompt: '/compact',
			options: {},
			createQuery: () =>
				scripted([
					{ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { content: [] } },
					{ type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { trigger: 'manual', pre_tokens: 10 } },
					{ type: 'result', usage: {}, duration_ms: 1, num_turns: 1 },
				]),
			requiresApproval: () => false,
			emit: async () => {},
		})
		expect(summary.sdkTailUuid).toBeNull()
	})
})
