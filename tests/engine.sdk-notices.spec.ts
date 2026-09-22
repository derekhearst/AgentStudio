import { expect, test } from '@playwright/test'
import { interpretSdkMessage } from '../src/lib/engine/sdk-notices'

/**
 * Interpreting the SDK messages the run loop used to drop.
 *
 * Pure-function tests: `src/lib/engine/sdk-notices.ts` has no DB, no SvelteKit and no I/O,
 * so this spec runs without Postgres or a dev server (same arrangement as
 * `automations.cron.spec.ts`).
 *
 * What is pinned here:
 *   - the messages the loop already handles come back null, so this stays safe to call on
 *     every message no matter where it sits in the loop
 *   - which notices persist. That is the judgment call in this module: a compaction
 *     boundary explains a transcript months later, a retry that then worked explains
 *     nothing, and a transcript full of retries is how a notice channel becomes noise
 *   - `background_tasks_changed` drops ambient tasks, which the SDK says hosts should keep
 *     out of activity indicators
 *   - a rate-limit event in its steady state says nothing and must not interrupt anyone
 */

test.describe('messages the loop already owns', () => {
	test('are left alone, so this can be called on everything', () => {
		expect(interpretSdkMessage({ type: 'assistant', message: {} })).toBeNull()
		expect(interpretSdkMessage({ type: 'user', message: {} })).toBeNull()
		expect(interpretSdkMessage({ type: 'result', usage: {} })).toBeNull()
		expect(interpretSdkMessage({ type: 'stream_event', event: {} })).toBeNull()
		expect(interpretSdkMessage({ type: 'system', subtype: 'thinking_tokens' })).toBeNull()
	})

	test('and so is anything unrecognised or malformed', () => {
		for (const value of [undefined, null, 'a string', 42, [], {}, { type: 'system' }]) {
			expect(() => interpretSdkMessage(value)).not.toThrow()
			expect(interpretSdkMessage(value)).toBeNull()
		}
		expect(interpretSdkMessage({ type: 'system', subtype: 'something_new' })).toBeNull()
	})
})

test.describe('compaction', () => {
	test('reports both sides of the boundary and is kept', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'compact_boundary',
			compact_metadata: { trigger: 'auto', pre_tokens: 120000, post_tokens: 18000 },
		})

		expect(result?.kind).toBe('notice')
		if (result?.kind !== 'notice') return
		expect(result.notice.kind).toBe('compacted')
		expect(result.notice.title.includes('120,000')).toBe(true)
		expect(result.notice.title.includes('18,000')).toBe(true)
		// Why the transcript above it is summarised — worth keeping.
		expect(result.notice.persist).toBe(true)
	})

	test('survives a boundary with no numbers on it', () => {
		const result = interpretSdkMessage({ type: 'system', subtype: 'compact_boundary' })
		expect(result?.kind === 'notice' && result.notice.kind).toBe('compacted')
	})
})

test.describe('transient vs durable', () => {
	test('an API retry is shown live but not persisted', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'api_retry',
			attempt: 2,
			max_retries: 5,
			error_status: 529,
		})

		expect(result?.kind).toBe('notice')
		if (result?.kind !== 'notice') return
		expect(result.notice.level).toBe('warn')
		expect(result.notice.title.includes('529')).toBe(true)
		expect(result.notice.title.includes('attempt 2 of 5')).toBe(true)
		// If the retry works the run is fine; if it does not, the failure speaks for itself.
		expect(result.notice.persist).toBe(false)
	})

	test('a model fallback is persisted, and says whether the session switched', () => {
		const session = interpretSdkMessage({
			type: 'system',
			subtype: 'model_refusal_fallback',
			original_model: 'claude-opus-5',
			fallback_model: 'claude-sonnet-5',
		})
		expect(session?.kind === 'notice' && session.notice.persist).toBe(true)
		expect(session?.kind === 'notice' && session.notice.title.includes('This session')).toBe(true)

		// `scope: 'local'` means only one reply came from the fallback model.
		const local = interpretSdkMessage({
			type: 'system',
			subtype: 'model_refusal_fallback',
			scope: 'local',
			original_model: 'claude-opus-5',
			fallback_model: 'claude-sonnet-5',
		})
		expect(local?.kind === 'notice' && local.notice.title.includes('One reply')).toBe(true)
	})

	test('a refusal with no fallback is an error and keeps its explanation', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'model_refusal_no_fallback',
			original_model: 'claude-opus-5',
			api_refusal_explanation: 'Refused for policy reasons.',
		})

		expect(result?.kind === 'notice' && result.notice.level).toBe('error')
		expect(result?.kind === 'notice' && result.notice.detail).toBe('Refused for policy reasons.')
	})

	test('unstable prose from the API is capped', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'model_refusal_no_fallback',
			original_model: 'm',
			api_refusal_explanation: 'x'.repeat(5000),
		})

		expect(result?.kind).toBe('notice')
		if (result?.kind !== 'notice') return
		expect((result.notice.detail?.length ?? 0) <= 401).toBe(true)
	})

	test('a tool refused by a permission rule is named and kept', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'permission_denied',
			tool_name: 'Bash',
			tool_use_id: 'x',
			decision_reason: 'Blocked by a deny rule.',
		})

		expect(result?.kind === 'notice' && result.notice.title.includes('Bash')).toBe(true)
		expect(result?.kind === 'notice' && result.notice.persist).toBe(true)
	})
})

test.describe('background tasks', () => {
	test('the payload is the whole live set', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'background_tasks_changed',
			tasks: [
				{ task_id: 't1', task_type: 'bash', description: 'bun run dev' },
				{ task_id: 't2', task_type: 'agent', description: 'Reviewing files' },
			],
		})

		expect(result?.kind).toBe('background_tasks')
		if (result?.kind !== 'background_tasks') return
		expect(result.tasks).toHaveLength(2)
		expect(result.tasks[0].description).toBe('bun run dev')
	})

	test('ambient tasks are dropped — the SDK says they are not activity', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'background_tasks_changed',
			tasks: [
				{ task_id: 't1', task_type: 'bash', description: 'real work' },
				{ task_id: 't2', task_type: 'watcher', description: 'live updates', ambient: true },
			],
		})

		expect(result?.kind === 'background_tasks' && result.tasks).toHaveLength(1)
	})

	test('an empty set is still a set, not a no-op', () => {
		// The last task finishing is exactly how the chips should clear.
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'background_tasks_changed',
			tasks: [],
		})
		expect(result?.kind).toBe('background_tasks')
		expect(result?.kind === 'background_tasks' && result.tasks).toHaveLength(0)
	})

	test('a finished task becomes a notice with its summary', () => {
		const done = interpretSdkMessage({
			type: 'system',
			subtype: 'task_notification',
			task_id: 't1',
			status: 'completed',
			summary: 'Tests passed',
			output_file: '/tmp/x',
		})
		expect(done?.kind === 'notice' && done.notice.level).toBe('info')
		expect(done?.kind === 'notice' && done.notice.detail).toBe('Tests passed')

		const failed = interpretSdkMessage({
			type: 'system',
			subtype: 'task_notification',
			task_id: 't2',
			status: 'failed',
			summary: 'Build broke',
			output_file: '/tmp/y',
		})
		expect(failed?.kind === 'notice' && failed.notice.level).toBe('error')
	})

	test('a task lost to a worker restart says so, rather than blaming the task', () => {
		const result = interpretSdkMessage({
			type: 'system',
			subtype: 'task_notification',
			task_id: 't3',
			status: 'stopped',
			reason: 'worker_restart',
			summary: '',
			output_file: '/tmp/z',
		})

		expect(result?.kind === 'notice' && result.notice.title.includes('worker restart')).toBe(true)
	})
})

test.describe('rate limits and progress', () => {
	test('the steady state says nothing', () => {
		expect(
			interpretSdkMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
		).toBeNull()
	})

	test('a warning warns; a rejection is an error and is kept', () => {
		const warning = interpretSdkMessage({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'allowed_warning' },
		})
		expect(warning?.kind === 'notice' && warning.notice.level).toBe('warn')
		expect(warning?.kind === 'notice' && warning.notice.persist).toBe(false)

		const rejected = interpretSdkMessage({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected' },
		})
		expect(rejected?.kind === 'notice' && rejected.notice.level).toBe('error')
		expect(rejected?.kind === 'notice' && rejected.notice.persist).toBe(true)
	})

	test('tool progress carries the call id and whole seconds', () => {
		const result = interpretSdkMessage({
			type: 'tool_progress',
			tool_use_id: 'toolu_1',
			tool_name: 'Bash',
			elapsed_time_seconds: 42.7,
		})

		expect(result?.kind).toBe('tool_progress')
		if (result?.kind !== 'tool_progress') return
		expect(result.toolUseId).toBe('toolu_1')
		expect(result.elapsedSeconds).toBe(43)
	})

	test('progress without an elapsed time is not progress', () => {
		expect(interpretSdkMessage({ type: 'tool_progress', tool_use_id: 'toolu_1' })).toBeNull()
	})
})
