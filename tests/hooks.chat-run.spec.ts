import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, seedAgent, uniquePrefix } from './helpers'
import { runEngineStream, type EngineQuerySource } from '../src/lib/engine/stream.server'
import { createChatRunHooks } from '../src/lib/hooks/chat-run-hooks.server'
import { emitHook, registerHook } from '../src/lib/hooks/bus.server'
import type { HookEvent, HookPayload } from '../src/lib/hooks/types'

/**
 * #144 — the hook bus on the chat path.
 *
 * `emitHook` was only called by the old runtime loop. Interactive chats run on the Agent SDK
 * engine, which never touched the bus, so an agent's hook bindings and the built-in
 * activity hooks ("ran Bash") did nothing for a chat — while the agent editor said the
 * built-ins fire automatically. These drive the real engine loop over a scripted SDK
 * stream, feed its frames to the chat's hooks exactly as the route does, and check what
 * reaches the bus; then the real bus, with an agent's binding, against the database.
 */

type Fired = { event: HookEvent; payload: Record<string, unknown> }

const CONTEXT = { runId: 'run-1', conversationId: 'conv-1', userId: 'user-1', agentId: 'agent-1' }

function recorder() {
	const fired: Fired[] = []
	const emit = async <E extends HookEvent>(event: E, payload: HookPayload<E>) => {
		fired.push({ event, payload: payload as unknown as Record<string, unknown> })
	}
	return { fired, hooks: createChatRunHooks(CONTEXT, emit) }
}

function scripted(messages: unknown[]): EngineQuerySource {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message as never
		},
	}
}

const RESULT = { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 }

function toolUse(id: string, name: string, input: unknown, parent: string | null = null) {
	return { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } }
}

function toolResult(id: string, text: string, opts: { parent?: string | null; isError?: boolean } = {}) {
	return {
		type: 'user',
		parent_tool_use_id: opts.parent ?? null,
		message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: opts.isError ?? false }] },
	}
}

/** One engine turn with the hooks listening on its frames, the way the route wires them. */
async function turn(messages: unknown[]) {
	const { fired, hooks } = recorder()
	hooks.runStarted()
	await runEngineStream({
		prompt: 'go',
		options: {},
		createQuery: () => scripted(messages),
		requiresApproval: () => false,
		emit: async (event, payload) => hooks.frame(event, payload),
	})
	hooks.runFinished({ success: true, costUsd: 0 })
	return fired
}

test.describe('hooks/chat-run — what a chat turn reports', () => {
	test("a tool call fires before_tool and after_tool with the model's arguments and the result", async () => {
		const fired = await turn([
			toolUse('t1', 'Bash', { command: 'ls' }),
			toolResult('t1', 'README.md'),
			toolUse('t2', 'Edit', { file_path: 'a.ts' }),
			toolResult('t2', 'no such file', { isError: true }),
			RESULT,
		])

		expect(fired.map((f) => f.event)).toEqual(['before_run', 'before_tool', 'after_tool', 'before_tool', 'after_tool', 'after_run'])
		const [, before, after, , failed] = fired
		expect(before.payload).toMatchObject({ ...CONTEXT, toolName: 'Bash', args: { command: 'ls' } })
		expect(after.payload).toMatchObject({ ...CONTEXT, toolName: 'Bash', args: { command: 'ls' }, result: 'README.md', success: true })
		expect(typeof after.payload.durationMs).toBe('number')
		expect(failed.payload).toMatchObject({ toolName: 'Edit', success: false })
	})

	test("a subagent's own calls are not reported as the parent's", async () => {
		const fired = await turn([
			toolUse('task1', 'Task', { subagent_type: 'reviewer', description: 'Review' }),
			toolUse('c1', 'Bash', { command: 'rm -rf x' }, 'task1'),
			toolResult('c1', 'done', { parent: 'task1' }),
			toolResult('task1', 'reviewed'),
			RESULT,
		])
		// The delegation is the parent's call (#32). It has no tool frames of its own now — its
		// card stands in — so it is reported off the card, as the SDK's `Agent` tool.
		const tools = fired.filter((f) => f.event === 'before_tool' || f.event === 'after_tool')
		expect(tools.map((f) => f.payload.toolName)).toEqual(['Agent', 'Agent'])
		expect(tools[0].payload).toMatchObject({ args: { subagent_type: 'reviewer', description: 'Review' } })
	})

	test("a delegation reports the child's report as its result, and a refusal as a failure (#32)", async () => {
		const fired = await turn([
			toolUse('a1', 'Agent', { subagent_type: 'reviewer', description: 'Review' }),
			{
				type: 'user',
				parent_tool_use_id: null,
				tool_use_result: {
					status: 'completed',
					agentId: 'sdk-1',
					content: [{ type: 'text', text: 'All good.' }],
					totalTokens: 10,
					totalToolUseCount: 0,
					totalDurationMs: 5,
					usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
				},
				message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'All good.' }] },
			},
			toolUse('a2', 'Agent', { subagent_type: 'writer', description: 'Draft' }),
			toolResult('a2', 'Refused: 4 delegated agents are already running.', { isError: true }),
			RESULT,
		])
		const after = fired.filter((f) => f.event === 'after_tool')
		expect(after.map((f) => [f.payload.toolName, f.payload.success])).toEqual([
			['Agent', true],
			['Agent', false],
		])
		expect(after[0].payload.result).toBe('All good.')
		expect(String(after[1].payload.result)).toContain('Refused')
	})

	test('a delegation awaiting approval is reported once approved, and not at all when denied (#32)', () => {
		const { fired, hooks } = recorder()
		// The order the engine sends: the approval card, then the child's card.
		hooks.frame('tool_pending', { id: 'a1', name: 'Agent', arguments: '{"subagent_type":"reviewer"}', token: 'run-1:a1' })
		hooks.frame('subagent_start', { agentId: 'a1', agentName: 'reviewer', conversationId: null, task: 'Review' })
		hooks.frame('tool_call', { id: 'a1', name: 'Agent', arguments: '{"subagent_type":"reviewer"}' })
		hooks.frame('subagent_done', { agentId: 'a1', conversationId: null, success: true, details: { report: 'ok' } })
		hooks.frame('tool_result', { id: 'a1', success: true, result: 'ok' })

		hooks.frame('tool_pending', { id: 'a2', name: 'Agent', arguments: '{}', token: 'run-1:a2' })
		hooks.frame('subagent_start', { agentId: 'a2', agentName: 'writer', conversationId: null, task: 'Draft' })
		hooks.frame('tool_denied', { id: 'a2' })
		hooks.frame('subagent_done', { agentId: 'a2', conversationId: null, success: false, error: 'denied' })

		expect(fired.map((f) => [f.event, (f.payload as { toolName?: string }).toolName])).toEqual([
			['on_approval_required', 'Agent'],
			['before_tool', 'Agent'],
			['after_tool', 'Agent'],
			['on_approval_required', 'Agent'],
		])
	})

	test('a failed turn reports after_run as failed and on_run_failed, once', () => {
		const { fired, hooks } = recorder()
		hooks.runStarted()
		hooks.runFinished({ success: false, costUsd: null, error: 'Model unavailable' })
		hooks.runFinished({ success: true, costUsd: 1 })
		expect(fired.map((f) => f.event)).toEqual(['before_run', 'after_run', 'on_run_failed'])
		expect(fired[1].payload).toMatchObject({ success: false, costUsd: null })
		expect(fired[2].payload).toMatchObject({ error: 'Model unavailable' })
	})

	test('an approval card and a question to the user are reported; a card nobody can answer is not', () => {
		const { fired, hooks } = recorder()
		hooks.frame('tool_pending', { id: 't1', name: 'push_branch', arguments: '{"branch":"main"}', token: 'run-1:t1' })
		hooks.frame('tool_pending', { id: 't2', name: 'Bash', arguments: '{}' })
		hooks.frame('ask_user', { id: 'run-1:q1', token: 'run-1:q1', questions: [{ question: 'a' }, { question: 'b' }] })
		expect(fired).toEqual([
			{ event: 'on_approval_required', payload: { ...CONTEXT, toolName: 'push_branch', args: { branch: 'main' }, token: 'run-1:t1' } },
			{ event: 'on_user_question', payload: { ...CONTEXT, token: 'run-1:q1', questionCount: 2 } },
		])
	})

	test('a hook that throws cannot fail the turn', async () => {
		const hooks = createChatRunHooks(CONTEXT, () => {
			throw new Error('boom')
		})
		expect(() => {
			hooks.runStarted()
			hooks.frame('tool_call', { id: 't1', name: 'Bash', arguments: '{}' })
			hooks.frame('tool_result', { id: 't1', success: true, result: 'ok' })
			hooks.runFinished({ success: true, costUsd: 0 })
		}).not.toThrow()
	})
})

test.describe('hooks/chat-run — through the real bus', () => {
	test("an agent's after_tool binding runs for a chat tool call, and is logged", async () => {
		const prefix = uniquePrefix('hooks-chat-run')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const userId = await getActiveUserId()
		const hookName = `${prefix}-opt-in`
		const seen: Array<HookPayload<'after_tool'>> = []
		// Opt-in: it runs only for an agent that binds it, which is the per-agent path.
		registerHook('after_tool', hookName, (payload) => void seen.push(payload), { optInOnly: true })

		try {
			const agent = await seedAgent(prefix)
			await sql`update agents set config = ${sql.json({ hooks: { after_tool: [hookName] } })} where id = ${agent.id}`
			const [conversation] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, agent_id, model, total_tokens, total_cost)
				values (${`${prefix} convo`}, ${userId}, ${agent.id}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const [run] = await sql<{ id: string }[]>`
				insert into chat_runs (id, conversation_id, user_id, state, source, label)
				values (${randomUUID()}, ${conversation.id}, ${userId}, 'running'::chat_run_state, 'chat_stream', ${`${prefix} run`})
				returning id
			`

			const hooks = createChatRunHooks({ runId: run.id, conversationId: conversation.id, userId, agentId: agent.id })
			hooks.frame('tool_call', { id: 'toolu_1', name: 'Read', arguments: '{"file_path":"README.md"}' })
			hooks.frame('tool_result', { id: 'toolu_1', name: 'Read', success: true, result: '# AgentStudio' })

			await expect.poll(() => seen.length).toBe(1)
			expect(seen[0]).toMatchObject({ runId: run.id, agentId: agent.id, toolName: 'Read', args: { file_path: 'README.md' }, success: true })
			await expect
				.poll(async () => (await sql`select 1 from hook_invocations where run_id = ${run.id} and hook_ref = ${hookName} and success`).length)
				.toBe(1)

			// Opt-in means opt-in: an agent that does not bind it never runs it. The bus used to
			// dispatch opt-in handlers with the global ones, so this one ran on every emit, and
			// twice for the agent above.
			const other = await seedAgent(`${prefix} other`)
			await emitHook(
				'after_tool',
				{ runId: run.id, conversationId: conversation.id, userId, agentId: other.id, toolName: 'Read', args: {}, result: null, success: true, durationMs: 1 },
				{ await: true },
			)
			expect(seen).toHaveLength(1)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('hooks/chat-run — the stream route uses it', () => {
	/* Read as source: the route's POST runs a real engine. */
	const source = readFileSync(resolve('src/routes/chat/[id]/stream/+server.ts'), 'utf8')

	test('every frame is shown to the hooks, and the turn is opened and closed on both ways out', () => {
		expect(source).toContain('createChatRunHooks(')
		// Inside `emit`, which every frame passes through — the engine's and the route's own.
		const emitBody = /const emit = async \(event: string, payload: unknown\) => \{([\s\S]*?)\n\t\t\t\}/.exec(source)
		expect(emitBody?.[1]).toContain('hooks.frame(event, payload)')
		// The engine call sits inside `runWithResumeFallback` (#24), which may make it twice; the
		// turn is opened once, before either attempt.
		const engineCall = source.search(/runEngineStream\(/)
		expect(engineCall).toBeGreaterThan(-1)
		expect(source.indexOf('hooks.runStarted()')).toBeGreaterThan(-1)
		expect(source.indexOf('hooks.runStarted()')).toBeLessThan(engineCall)
		expect(source.match(/hooks\.runFinished\(/g)?.length).toBe(2)
		// The agent the turn runs as, so the default Chat agent's bindings apply too.
		expect(source).toMatch(/createChatRunHooks\(\{[\s\S]*?agentId: agent\.id/)
	})
})
