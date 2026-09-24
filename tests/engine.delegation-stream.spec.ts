import { expect, test } from '@playwright/test'
import type { HookCallbackMatcher, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { runEngineStream, type EngineRunInput, type EngineQuerySource } from '../src/lib/engine/stream.server'
import { createDelegationGate, capReachedReason, NESTED_DELEGATION_REASON } from '../src/lib/engine/delegation-gate'
import { STOPPED_REASON } from '../src/lib/engine/subagent-block'
import type { EngineQueryHandle } from '../src/lib/engine/run-registry.server'
import type { StreamBlock } from '../src/lib/runs/runs.schema'

/**
 * #32 — fan-out through the engine loop, driven with a scripted SDK.
 *
 * The script plays the CLI: it announces the parent's `Agent` calls, runs the permission
 * pipeline for each (the PreToolUse hook, then `canUseTool` when the hook asks), and answers
 * with the child's messages and the delegation's typed result. What comes out — frames,
 * blocks, hook answers — is what the chat page and the ledger see.
 *
 * Needs a database only because `stream.server.ts` transitively imports the tool registry.
 */

type Frame = { event: string; payload: Record<string, unknown> }
type SubagentStreamBlock = Extract<StreamBlock, { kind: 'subagent' }>
type HookAnswer = { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> }

const WS = process.platform === 'win32' ? 'C:\\sandbox\\u1\\runs\\r1' : '/sandbox/u1/runs/r1'
const RESULT = { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 }

function toolUse(id: string, name: string, input: unknown, parent: string | null = null) {
	return { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } }
}

function childText(parent: string, text: string, call?: { id: string; usage: Record<string, number> }) {
	return {
		type: 'assistant',
		parent_tool_use_id: parent,
		message: {
			...(call ? { id: call.id, model: 'claude-haiku-4-5', usage: call.usage } : {}),
			content: [{ type: 'text', text }],
		},
	}
}

/** The CLI's own answer for a delegation cut short by Stop (read in 2.1.278). */
const INTERRUPTED = '[Request interrupted by user for tool use]'

function taskNotification(toolUseId: string, status: 'completed' | 'failed' | 'stopped', summary = '') {
	return {
		type: 'system',
		subtype: 'task_notification',
		task_id: `task-${toolUseId}`,
		tool_use_id: toolUseId,
		status,
		summary,
		output_file: '',
	}
}

/** The placeholder a child the CLI sent to the background answers its call with. */
const launched = (agentId: string) => ({
	status: 'async_launched',
	agentId,
	description: 'x',
	prompt: 'p',
	outputFile: '/tmp/o',
})

function toolResult(id: string, text: string, parent: string | null = null, structured?: unknown, isError = false) {
	return {
		type: 'user',
		parent_tool_use_id: parent,
		tool_use_result: structured,
		message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
	}
}

/** A completed foreground child's `AgentOutput`, as the SDK types it. */
function agentOutput(overrides: Record<string, unknown> = {}) {
	return {
		status: 'completed',
		agentId: 'sdk-agent-1',
		agentType: 'reviewer',
		content: [{ type: 'text', text: 'All good.' }],
		prompt: 'Review it',
		resolvedModel: 'claude-sonnet-4-5',
		totalToolUseCount: 2,
		totalDurationMs: 4_200,
		totalTokens: 12_345,
		usage: {
			input_tokens: 100,
			output_tokens: 40,
			cache_creation_input_tokens: 5,
			cache_read_input_tokens: 12_200,
			server_tool_use: null,
			service_tier: null,
			cache_creation: null,
		},
		...overrides,
	}
}

const delegate = (id: string, key = 'reviewer', extra: Record<string, unknown> = {}) =>
	toolUse(id, 'Agent', { subagent_type: key, description: `Task ${id}`, prompt: 'Review it', ...extra })

/** Run the CLI's pipeline for one call against the options the engine built. */
async function pipeline(
	options: Options,
	call: { id: string; name: string; input: Record<string, unknown>; agentId?: string },
): Promise<{ hook: HookAnswer; permission: PermissionResult | null }> {
	let hook: HookAnswer = {}
	for (const matcher of (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
		for (const fn of matcher.hooks) {
			const out = (await fn(
				{
					hook_event_name: 'PreToolUse',
					session_id: 's',
					transcript_path: '',
					cwd: WS,
					tool_name: call.name,
					tool_input: call.input,
					tool_use_id: call.id,
					...(call.agentId ? { agent_id: call.agentId } : {}),
				} as never,
				call.id,
				{ signal: new AbortController().signal },
			)) as { hookSpecificOutput?: HookAnswer }
			hook = { ...hook, ...(out.hookSpecificOutput ?? {}) }
		}
	}
	if (hook.permissionDecision === 'deny') return { hook, permission: null }
	// The CLI consults `canUseTool` for an 'ask'; `Agent` never asks on its own in our modes.
	if (hook.permissionDecision !== 'ask') return { hook, permission: { behavior: 'allow' } }
	const permission = await options.canUseTool!(call.name, hook.updatedInput ?? call.input, {
		signal: new AbortController().signal,
		toolUseID: call.id,
		requestId: 'r',
	})
	return { hook, permission }
}

type Script = (options: Options) => AsyncGenerator<unknown>

async function run(script: Script, input: Partial<EngineRunInput> = {}) {
	const frames: Frame[] = []
	const summary = await runEngineStream({
		prompt: 'go',
		options: {},
		workspaceRoot: WS,
		bashPolicy: 'sandboxed',
		requiresApproval: () => false,
		...input,
		createQuery: ({ options }): EngineQuerySource => ({
			async *[Symbol.asyncIterator]() {
				for await (const message of script(options)) yield message as never
			},
		}),
		emit: async (event, payload) => {
			frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
		},
	})
	const children = summary.blocks.filter((b): b is SubagentStreamBlock => b.kind === 'subagent')
	return { frames, summary, children }
}

const named = (frames: Frame[], event: string) => frames.filter((f) => f.event === event)

test.describe('the hook admits a delegation', () => {
	test('in the foreground, with isolation stripped, as a plain input rewrite', async () => {
		const gate = createDelegationGate({ parentIsClaude: false })
		let answer: HookAnswer = {}
		const slots: number[] = []
		await run(
			async function* (options) {
				const input = { subagent_type: 'reviewer', prompt: 'p', run_in_background: true, isolation: 'worktree', model: 'opus' }
				yield toolUse('a1', 'Agent', input)
				answer = (await pipeline(options, { id: 'a1', name: 'Agent', input })).hook
				slots.push(gate.live())
				yield toolResult('a1', 'done', null, agentOutput())
				// Read before the turn ends, whose reset would hide a slot never given back.
				slots.push(gate.live())
				yield RESULT
			},
			{ delegation: gate },
		)
		// No decision: the CLI applies it as an input change and leaves its own pipeline be.
		expect(answer.permissionDecision).toBeUndefined()
		expect(answer.updatedInput).toEqual({ subagent_type: 'reviewer', prompt: 'p', run_in_background: false })
		// The child held a slot while it ran, and gave it back with its result.
		expect(slots).toEqual([1, 0])
	})

	test('an older CLI calling it Task is gated the same way', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		let answer: HookAnswer = {}
		await run(
			async function* (options) {
				yield toolUse('t1', 'Task', { subagent_type: 'reviewer', prompt: 'p' })
				answer = (await pipeline(options, { id: 't1', name: 'Task', input: { subagent_type: 'reviewer', prompt: 'p' } })).hook
				yield RESULT
			},
			{ delegation: gate },
		)
		expect(answer.updatedInput?.run_in_background).toBe(false)
	})

	test('a fan-out past the cap is refused until a child reports back', async () => {
		const gate = createDelegationGate({ parentIsClaude: true, maxConcurrent: 2 })
		const answers: HookAnswer[] = []
		const { children } = await run(
			async function* (options) {
				const input = { subagent_type: 'reviewer', prompt: 'p' }
				for (const id of ['a1', 'a2', 'a3']) yield toolUse(id, 'Agent', input)
				for (const id of ['a1', 'a2', 'a3']) answers.push((await pipeline(options, { id, name: 'Agent', input })).hook)
				// The refused call is answered with the refusal, as the CLI does.
				yield toolResult('a3', capReachedReason(2), null, undefined, true)
				yield toolResult('a1', 'done', null, agentOutput())
				// With a1 back, the model re-issues the one that was refused.
				yield toolUse('a4', 'Agent', input)
				answers.push((await pipeline(options, { id: 'a4', name: 'Agent', input })).hook)
				yield toolResult('a2', 'done', null, agentOutput({ agentId: 'sdk-2' }))
				yield toolResult('a4', 'done', null, agentOutput({ agentId: 'sdk-4' }))
				yield RESULT
			},
			{ delegation: gate },
		)
		expect(answers.map((a) => a.permissionDecision ?? 'rewrite')).toEqual(['rewrite', 'rewrite', 'deny', 'rewrite'])
		expect(answers[2].permissionDecisionReason).toBe(capReachedReason(2))
		// The refused one still has a card, and it says why.
		const refused = children.find((c) => c.agentId === 'a3')
		expect(refused?.status).toBe('failed')
		expect(refused?.error).toContain('Wait for the running children to finish')
		expect(children.filter((c) => c.status === 'completed').map((c) => c.agentId)).toEqual(['a1', 'a2', 'a4'])
		expect(gate.live()).toBe(0)
	})

	test("a child's own delegation is refused", async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		let answer: HookAnswer = {}
		const { children } = await run(
			async function* (options) {
				yield delegate('a1')
				await pipeline(options, { id: 'a1', name: 'Agent', input: { subagent_type: 'reviewer', prompt: 'p' } })
				yield toolUse('n1', 'Agent', { subagent_type: 'writer', prompt: 'deeper' }, 'a1')
				answer = (await pipeline(options, { id: 'n1', name: 'Agent', input: { prompt: 'deeper' }, agentId: 'sdk-1' })).hook
				yield toolResult('n1', NESTED_DELEGATION_REASON, 'a1', undefined, true)
				yield toolResult('a1', 'done', null, agentOutput())
				yield RESULT
			},
			{ delegation: gate },
		)
		expect(answer.permissionDecision).toBe('deny')
		expect(answer.permissionDecisionReason).toBe(NESTED_DELEGATION_REASON)
		// The attempt is in the child's own transcript, marked failed, and opened no card of its own.
		expect(children).toHaveLength(1)
		expect(children[0].transcript).toContainEqual({ kind: 'tool', name: 'Agent', success: false })
	})

	test('plan mode refuses the delegation before it takes a slot', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		let answer: HookAnswer = {}
		await run(
			async function* (options) {
				yield delegate('a1')
				answer = (await pipeline(options, { id: 'a1', name: 'Agent', input: { subagent_type: 'reviewer', prompt: 'p' } })).hook
				yield RESULT
			},
			{ delegation: gate, permissionMode: 'plan' },
		)
		expect(answer.permissionDecision).toBe('deny')
		expect(answer.permissionDecisionReason).toMatch(/Plan mode/)
		expect(gate.live()).toBe(0)
	})

	test('a delegation that needs approval carries its rewrite through canUseTool', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		let outcome: { hook: HookAnswer; permission: PermissionResult | null } | null = null
		const { frames } = await run(
			async function* (options) {
				const input = { subagent_type: 'reviewer', prompt: 'p', run_in_background: true }
				yield toolUse('a1', 'Agent', input)
				outcome = await pipeline(options, { id: 'a1', name: 'Agent', input })
				yield toolResult('a1', 'done', null, agentOutput())
				yield RESULT
			},
			{
				delegation: gate,
				requiresApproval: (name) => name === 'Agent',
				approvalToken: (id) => `run1:${id}`,
				requestApproval: async () => ({ allow: true }),
			},
		)
		expect(outcome!.hook.permissionDecision).toBe('ask')
		expect(outcome!.hook.updatedInput?.run_in_background).toBe(false)
		expect(outcome!.permission).toMatchObject({ behavior: 'allow', updatedInput: { run_in_background: false } })
		// The approval card is the one tool card a delegation gets, and it is resolved.
		expect(frames.filter((f) => f.payload.id === 'a1').map((f) => f.event)).toEqual([
			'tool_pending',
			'tool_call',
			'tool_result',
		])
	})
})

test.describe("the child's card", () => {
	test('opens at the call, stands in for it, and closes with the typed result', async () => {
		const { frames, summary, children } = await run(async function* () {
			yield delegate('a1')
			yield toolUse('c1', 'Read', { file_path: 'src/a.ts' }, 'a1')
			yield toolResult('c1', 'contents', 'a1')
			yield childText('a1', 'All good.')
			yield toolResult('a1', 'All good.', null, agentOutput())
			yield RESULT
		})

		// Opened by the parent's call, before the child said anything.
		expect(frames[0]).toEqual({
			event: 'subagent_start',
			payload: { agentId: 'a1', agentName: 'reviewer', conversationId: null, task: 'Task a1' },
		})
		// No generic tool card beside it, live or persisted.
		expect(named(frames, 'tool_call')).toHaveLength(0)
		expect(named(frames, 'tool_result')).toHaveLength(0)
		expect(summary.blocks.filter((b) => b.kind === 'tool')).toHaveLength(0)

		const [done] = named(frames, 'subagent_done')
		expect(done.payload).toMatchObject({ agentId: 'a1', success: true, status: 'completed' })
		expect(done.payload.details).toMatchObject({ kind: 'subagent', totalTokens: 12_345, totalDurationMs: 4_200 })

		expect(children).toHaveLength(1)
		expect(children[0]).toMatchObject({ status: 'completed', success: true, content: 'All good.' })
		expect(children[0].details?.usage).toEqual({
			inputTokens: 100,
			outputTokens: 40,
			cacheCreationTokens: 5,
			cacheReadTokens: 12_200,
		})
		// The transcript keeps the order: the read, then what it concluded.
		expect(children[0].transcript).toEqual([
			{ kind: 'tool', name: 'Read', label: 'src/a.ts', success: true },
			{ kind: 'text', text: 'All good.' },
		])
		expect(named(frames, 'subagent_tool_call')[0].payload.label).toBe('src/a.ts')
	})

	test("three children interleaved land on three cards, each with its own transcript", async () => {
		const { children } = await run(async function* () {
			for (const id of ['a1', 'a2', 'a3']) yield delegate(id)
			yield childText('a2', 'two')
			yield childText('a1', 'one')
			yield toolUse('c3', 'Grep', { pattern: 'TODO' }, 'a3')
			yield childText('a3', 'three')
			yield toolResult('c3', 'hits', 'a3')
			for (const id of ['a2', 'a1', 'a3']) yield toolResult(id, 'done', null, agentOutput({ agentId: `sdk-${id}` }))
			yield RESULT
		})
		expect(children.map((c) => c.agentId)).toEqual(['a1', 'a2', 'a3'])
		expect(children.map((c) => c.content)).toEqual(['one', 'two', 'three'])
		expect(children[2].transcript).toEqual([
			{ kind: 'tool', name: 'Grep', label: 'TODO', success: true },
			{ kind: 'text', text: 'three' },
		])
		expect(children.map((c) => c.details?.sdkAgentId)).toEqual(['sdk-a1', 'sdk-a2', 'sdk-a3'])
	})

	test("a child's text is recorded once, whether it arrives whole or as deltas", async () => {
		const deltas = await run(async function* () {
			yield delegate('a1')
			yield {
				type: 'stream_event',
				parent_tool_use_id: 'a1',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streamed' } },
			}
			// The same words again as the whole message: ignored for a child that streams.
			yield childText('a1', 'streamed')
			yield RESULT
		})
		expect(deltas.children[0].content).toBe('streamed')

		const whole = await run(async function* () {
			yield delegate('a1')
			yield childText('a1', 'first')
			yield childText('a1', 'second')
			yield RESULT
		})
		expect(whole.children[0].content).toBe('first\n\nsecond')
		// Never the parent's reply.
		expect(whole.summary.text).toBe('')
	})

	test('a refusal closes the card as failed, with the reason', async () => {
		const { frames, children } = await run(async function* () {
			yield delegate('a1')
			yield toolResult('a1', 'Refused: over budget', null, undefined, true)
			yield RESULT
		})
		expect(children[0]).toMatchObject({ status: 'failed', success: false, error: 'Refused: over budget' })
		expect(named(frames, 'subagent_done')[0].payload).toMatchObject({ status: 'failed', error: 'Refused: over budget' })
	})

	test('a background launch placeholder does not close the card; the end of the turn does', async () => {
		const { frames, children } = await run(async function* () {
			yield delegate('a1')
			yield toolResult('a1', 'launched', null, {
				status: 'async_launched',
				agentId: 'bg-1',
				description: 'x',
				prompt: 'p',
				outputFile: '/tmp/o',
			})
			yield RESULT
		})
		const done = named(frames, 'subagent_done')
		expect(done).toHaveLength(1)
		expect(done[0].payload).toMatchObject({ agentId: 'a1', status: 'stopped' })
		expect(children[0].details?.status).toBe('async_launched')
		expect(children[0].status).toBe('stopped')
	})

	test('Stop: the CLI answers a running child with an interrupt error, and its card says stopped', async () => {
		let handle: EngineQueryHandle | null = null
		const { frames, children } = await run(
			async function* () {
				yield delegate('a1')
				yield delegate('a2')
				yield toolResult('a1', 'done', null, agentOutput())
				yield toolUse('c2', 'Bash', { command: 'sleep 100' }, 'a2')
				// The user presses Stop. The CLI answers the child still running with an error of
				// its own making before the turn's result, as 2.1.278 does.
				await handle!.interrupt()
				yield toolResult('a2', INTERRUPTED, null, INTERRUPTED, true)
				yield { ...RESULT, is_error: true, subtype: 'error_during_execution' }
			},
			{ onHandle: (h) => (handle = h) },
		)
		expect(children.map((c) => c.status)).toEqual(['completed', 'stopped'])
		expect(children[1]).toMatchObject({ success: false, error: STOPPED_REASON })
		expect(named(frames, 'subagent_done').map((f) => [f.payload.agentId, f.payload.status])).toEqual([
			['a1', 'completed'],
			['a2', 'stopped'],
		])
	})

	test("after Stop, the CLI's synthetic cancellation reads as stopped too, whatever its wording", async () => {
		let handle: EngineQueryHandle | null = null
		const { children } = await run(
			async function* () {
				yield delegate('a1')
				await handle!.interrupt()
				yield toolResult('a1', "The user doesn't want to proceed with this tool use.", null, 'User rejected tool use', true)
				yield RESULT
			},
			{ onHandle: (h) => (handle = h) },
		)
		expect(children[0].status).toBe('stopped')
	})

	test("the CLI's interrupt text alone is a stop; any other error, with no Stop sent, is a failure", async () => {
		const { children } = await run(async function* () {
			yield delegate('a1')
			yield delegate('a2')
			yield toolResult('a1', INTERRUPTED, null, undefined, true)
			yield toolResult('a2', 'Agent crashed: out of memory', null, undefined, true)
			yield RESULT
		})
		expect(children.map((c) => [c.status, c.error])).toEqual([
			['stopped', STOPPED_REASON],
			['failed', 'Agent crashed: out of memory'],
		])
	})

	test('a child still running when the turn ends, with no answer at all, is closed as stopped', async () => {
		const { frames, children } = await run(async function* () {
			yield delegate('a1')
			yield delegate('a2')
			yield toolResult('a1', 'done', null, agentOutput())
			yield toolUse('c2', 'Bash', { command: 'sleep 100' }, 'a2')
			// The CLI went away with a2 in flight.
			yield { ...RESULT, is_error: true, subtype: 'error_during_execution' }
		})
		expect(children.map((c) => c.status)).toEqual(['completed', 'stopped'])
		expect(named(frames, 'subagent_done').map((f) => [f.payload.agentId, f.payload.status])).toEqual([
			['a1', 'completed'],
			['a2', 'stopped'],
		])
	})

	test("a delegation's task notification is its card's business, not a generic notice", async () => {
		const { frames, summary } = await run(async function* () {
			yield delegate('a1')
			yield { type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'a1', status: 'completed', summary: 'ok', output_file: '' }
			yield { type: 'system', subtype: 'task_notification', task_id: 'k2', tool_use_id: 'bash-9', status: 'completed', summary: 'ok', output_file: '' }
			yield toolResult('a1', 'done', null, agentOutput())
			yield RESULT
		})
		// Only the unrelated task's notice survives.
		expect(named(frames, 'notice')).toHaveLength(1)
		expect(summary.blocks.filter((b) => b.kind === 'notice')).toHaveLength(1)
	})
})

test.describe('a child the CLI sent to the background anyway', () => {
	// An agent definition with `background: true` (a trusted project's `.claude/agents/`) is
	// backgrounded whatever the call's own `run_in_background` says.
	test('keeps its slot until its task notification, so the cap still holds', async () => {
		const gate = createDelegationGate({ parentIsClaude: true, maxConcurrent: 1 })
		const answers: HookAnswer[] = []
		const slots: number[] = []
		const { frames, children } = await run(
			async function* (options) {
				const input = { subagent_type: 'background-reviewer', prompt: 'p' }
				yield toolUse('a1', 'Agent', input)
				answers.push((await pipeline(options, { id: 'a1', name: 'Agent', input })).hook)
				// The placeholder: the call is answered, but the child is still working.
				yield toolResult('a1', 'Async agent launched', null, launched('bg-1'))
				slots.push(gate.live())
				// So the next delegation still meets a full house.
				yield toolUse('a2', 'Agent', input)
				answers.push((await pipeline(options, { id: 'a2', name: 'Agent', input })).hook)
				yield toolResult('a2', capReachedReason(1), null, undefined, true)
				// The child finishes: its notification closes its card and hands its slot back.
				yield taskNotification('a1', 'completed', 'Reviewed three files, no problems.')
				slots.push(gate.live())
				yield toolUse('a3', 'Agent', input)
				answers.push((await pipeline(options, { id: 'a3', name: 'Agent', input })).hook)
				yield toolResult('a3', 'done', null, agentOutput())
				yield RESULT
			},
			{ delegation: gate },
		)
		expect(slots).toEqual([1, 0])
		expect(answers.map((a) => a.permissionDecision ?? 'rewrite')).toEqual(['rewrite', 'deny', 'rewrite'])
		expect(children.map((c) => [c.agentId, c.status])).toEqual([
			['a1', 'completed'],
			['a2', 'failed'],
			['a3', 'completed'],
		])
		// The summary stands in for the report that never came back through the call.
		expect(children[0].content).toBe('Reviewed three files, no problems.')
		expect(named(frames, 'subagent_done').map((f) => f.payload.agentId)).toEqual(['a2', 'a1', 'a3'])
		// And the notification is the card's business, not a generic notice.
		expect(named(frames, 'notice')).toHaveLength(0)
	})

	test('its notification says how it ended, even when it comes before the placeholder', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		const slots: number[] = []
		const { children } = await run(
			async function* (options) {
				for (const id of ['a1', 'a2']) {
					yield delegate(id)
					await pipeline(options, { id, name: 'Agent', input: { subagent_type: 'reviewer', prompt: 'p' } })
				}
				yield toolResult('a1', 'launched', null, launched('bg-1'))
				yield taskNotification('a1', 'failed', 'Hit the tool limit.')
				yield taskNotification('a2', 'stopped')
				yield toolResult('a2', 'launched', null, launched('bg-2'))
				slots.push(gate.live())
				yield RESULT
			},
			{ delegation: gate },
		)
		expect(slots).toEqual([0])
		expect(children.map((c) => [c.status, c.error])).toEqual([
			['failed', 'Hit the tool limit.'],
			['stopped', STOPPED_REASON],
		])
	})
})

test.describe('what a child spent', () => {
	const u = (input: number, output: number, cacheRead = 0) => ({
		input_tokens: input,
		output_tokens: output,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: cacheRead,
	})

	test('is added up over its model calls, not read off its last one, and rides on its done frame', async () => {
		const { frames, children } = await run(async function* () {
			yield delegate('a1')
			// Call 1, split into two messages: text, then a tool call. The first carries the
			// provisional output count.
			yield childText('a1', 'Looking.', { id: 'msg_1', usage: u(1_000, 1) })
			yield {
				type: 'assistant',
				parent_tool_use_id: 'a1',
				message: {
					id: 'msg_1',
					usage: u(1_000, 80),
					content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }],
				},
			}
			yield toolResult('c1', 'contents', 'a1')
			// Call 2, streamed: its start, then its final count.
			yield {
				type: 'stream_event',
				parent_tool_use_id: 'a1',
				event: { type: 'message_start', message: { id: 'msg_2', usage: u(200, 1, 1_000) } },
			}
			yield { type: 'stream_event', parent_tool_use_id: 'a1', event: { type: 'message_delta', usage: { output_tokens: 30 } } }
			yield childText('a1', 'All good.', { id: 'msg_2', usage: u(200, 1, 1_000) })
			// The typed result reports the last call only.
			yield toolResult('a1', 'All good.', null, agentOutput({ usage: u(200, 40, 1_000) }))
			yield RESULT
		})
		const expected = {
			inputTokens: 1_200,
			outputTokens: 120,
			cacheCreationTokens: 0,
			cacheReadTokens: 1_000,
			modelCalls: 2,
			model: 'claude-haiku-4-5',
		}
		expect(children[0].usage).toEqual(expected)
		expect(named(frames, 'subagent_done')[0].payload.usage).toEqual(expected)
		// The SDK's own figure is kept as it was reported.
		expect(children[0].details?.usage?.outputTokens).toBe(40)
	})

	test('a stopped child keeps what it spent before it was stopped', async () => {
		const { children } = await run(async function* () {
			yield delegate('a1')
			yield childText('a1', 'Starting.', { id: 'msg_1', usage: u(500, 25) })
			yield { ...RESULT, is_error: true }
		})
		expect(children[0]).toMatchObject({ status: 'stopped', usage: { inputTokens: 500, outputTokens: 25, modelCalls: 1 } })
	})

	test('the caller books each child the moment its card closes, before the loop reads on', async () => {
		const booked: string[] = []
		const seen: string[][] = []
		await run(
			async function* () {
				yield delegate('a1')
				yield delegate('a2')
				yield toolResult('a1', 'done', null, agentOutput())
				// The next wave's budget check would run about here, and a1 is already booked.
				seen.push([...booked])
				yield toolResult('a2', 'Refused: over budget', null, undefined, true)
				yield delegate('a3')
				yield RESULT
			},
			{
				onSubagentDone: async (block) => {
					booked.push(`${block.agentId}:${block.status}`)
				},
			},
		)
		expect(seen).toEqual([['a1:completed']])
		expect(booked).toEqual(['a1:completed', 'a2:failed', 'a3:stopped'])
	})

	test('a caller whose booking throws does not end the turn', async () => {
		const { summary } = await run(
			async function* () {
				yield delegate('a1')
				yield toolResult('a1', 'done', null, agentOutput())
				yield { ...RESULT, session_id: 's1' }
			},
			{
				onSubagentDone: async () => {
					throw new Error('ledger down')
				},
			},
		)
		expect(summary.sessionId).toBe('s1')
	})
})

test.describe('what the summary tells the ledger', () => {
	test('whether the turn usage already counts the children', async () => {
		const modelUsage = {
			'claude-sonnet-4-5': { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
		}
		const fresh = await run(async function* () {
			yield { ...RESULT, session_id: 's1', modelUsage, total_cost_usd: 0.01 }
		})
		expect(fresh.summary.usageIncludesSubagents).toEqual({ tokens: true, cost: true })

		const resumedNoBaseline = await run(
			async function* () {
				yield { ...RESULT, session_id: 's1', modelUsage, total_cost_usd: 0.01 }
			},
			{ options: { resume: 's1' } },
		)
		expect(resumedNoBaseline.summary.usageIncludesSubagents).toEqual({ tokens: false, cost: false })
	})
})
