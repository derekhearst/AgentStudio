import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { HookCallbackMatcher, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { runEngineStream, type EngineRunInput, type EngineQuerySource } from '../src/lib/engine/stream.server'
import { resolveToolScope } from '../src/lib/engine/tool-scope'
import { HOST_OWNED_TOOLS } from '../src/lib/engine/builtin-tools'
import { allToolNames } from '../src/lib/tools/tool-schemas'

/**
 * How the engine gates a call, driven the way the SDK drives it.
 *
 * The scripted stream below plays the SDK's part: it yields the assistant message that
 * announces a call, then runs the permission pipeline the CLI runs — the PreToolUse hook
 * first, and `canUseTool` only when the hook asks — then yields the result. Everything the
 * operator would see comes out as frames.
 *
 * What this pins, each a defect that shipped:
 *
 *   - every call meets the gate: a PreToolUse hook is always installed (the SDK consults it
 *     before allow rules and modes, which `canUseTool` alone is not), and `allowedTools` is
 *     never passed through
 *   - a pending card carries its approval token, without which the chat's Allow/Deny buttons
 *     never rendered and every approval timed out as a denial
 *   - a call that containment will ask about (Bash with no bubblewrap) is shown as pending,
 *     not as executing
 *   - a subagent's call that needs approval gets a card the operator can answer
 *
 * And one that has not shipped: the tools the engine hands to the host ungated are exactly
 * the ones the settings approval list and /api/mcp leave out, so the list never offers a
 * setting for a call the engine hands over, nor hides one it gates.
 *
 * Needs a database only because `stream.server.ts` transitively imports the tool registry.
 */

type Frame = { event: string; payload: Record<string, unknown> }

const WS = process.platform === 'win32' ? 'C:\\sandbox\\u1\\runs\\r1' : '/sandbox/u1/runs/r1'
const RESULT = { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 }

function toolUse(id: string, name: string, input: unknown, parent: string | null = null) {
	return {
		type: 'assistant',
		parent_tool_use_id: parent,
		message: { content: [{ type: 'tool_use', id, name, input }] },
	}
}

function toolResult(id: string, text: string, parent: string | null = null, isError = false) {
	return {
		type: 'user',
		parent_tool_use_id: parent,
		message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
	}
}

type Call = { id: string; name: string; input: Record<string, unknown>; parent?: string | null }
type Outcome = { hook: string; permission: PermissionResult | null }

/**
 * Run the SDK's permission pipeline for one call against the options the engine built:
 * hook first; `canUseTool` only when the hook said 'ask' or said nothing.
 */
async function pipeline(options: Options, call: Call): Promise<Outcome> {
	const matchers = (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]
	let hook = 'none'
	for (const matcher of matchers) {
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
					...(call.parent ? { agent_id: 'a1' } : {}),
				} as never,
				call.id,
				{ signal: new AbortController().signal },
			)) as { hookSpecificOutput?: { permissionDecision?: string } }
			hook = out.hookSpecificOutput?.permissionDecision ?? hook
		}
	}
	if (hook === 'deny') return { hook, permission: null }
	const permission = await options.canUseTool!(call.name, call.input, {
		signal: new AbortController().signal,
		toolUseID: call.id,
		requestId: 'r',
	})
	return { hook, permission }
}

/** A scripted SDK: announce each call, run the pipeline, answer it, finish. */
async function drive(input: Partial<EngineRunInput>, calls: Call[], extra: unknown[] = []) {
	const frames: Frame[] = []
	const outcomes: Outcome[] = []
	let seen: Options | null = null
	const summary = await runEngineStream({
		prompt: 'go',
		options: {},
		workspaceRoot: WS,
		bashPolicy: 'sandboxed',
		requiresApproval: () => false,
		...input,
		createQuery: ({ options }): EngineQuerySource => {
			seen = options
			return {
				async *[Symbol.asyncIterator]() {
					for (const call of calls) {
						yield toolUse(call.id, call.name, call.input, call.parent ?? null) as never
						const outcome = await pipeline(options, call)
						outcomes.push(outcome)
						const allowed = outcome.permission?.behavior === 'allow'
						yield toolResult(call.id, allowed ? 'ok' : 'refused', call.parent ?? null, !allowed) as never
					}
					for (const message of extra) yield message as never
					yield RESULT as never
				},
			}
		},
		emit: async (event, payload) => {
			frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
		},
	})
	return { frames, outcomes, summary, options: seen! as Options }
}

const events = (frames: Frame[], id: string) => frames.filter((f) => f.payload.id === id).map((f) => f.event)

test.describe('every call meets the gate', () => {
	test('a PreToolUse hook and canUseTool are always installed; allowedTools never is', async () => {
		const { options } = await drive({}, [])
		expect((options.hooks?.PreToolUse ?? []).length).toBeGreaterThan(0)
		expect(typeof options.canUseTool).toBe('function')
		expect(options.allowedTools).toBeUndefined()
	})

	test('a caller-supplied hook is kept, behind ours', async () => {
		const theirs: HookCallbackMatcher = { hooks: [async () => ({})] }
		const { options } = await drive({ options: { hooks: { PreToolUse: [theirs] } } }, [])
		const matchers = options.hooks!.PreToolUse!
		expect(matchers).toHaveLength(2)
		expect(matchers[1]).toBe(theirs)
	})

	test('the hook refuses a read outside the workspace — no allow rule gets a say', async () => {
		const { outcomes, frames } = await drive({}, [{ id: 't1', name: 'Read', input: { file_path: '/etc/shadow' } }])
		expect(outcomes[0].hook).toBe('deny')
		// The block is announced, then resolved as denied — in that order.
		expect(events(frames, 't1').slice(0, 2)).toEqual(['tool_pending', 'tool_denied'])
	})

	test('the hook refuses a tool outside the agent scope', async () => {
		const toolScope = resolveToolScope(['Read', 'web_search'], { delegation: false })
		const { outcomes } = await drive({ toolScope }, [
			{ id: 't1', name: 'mcp__agentstudio__create_automation', input: {} },
		])
		expect(outcomes[0].hook).toBe('deny')
	})

	test('a mandatory-approval tool is asked about even under bypassPermissions', async () => {
		const { outcomes, frames } = await drive(
			{
				permissionMode: 'bypassPermissions',
				approvalToken: (id) => `run1:${id}`,
				requestApproval: async () => ({ allow: false, reason: 'Denied by user' }),
			},
			[{ id: 't1', name: 'mcp__agentstudio__push_branch', input: { owner: 'o', repo: 'r' } }],
		)
		expect(outcomes[0].hook).toBe('ask')
		expect(outcomes[0].permission?.behavior).toBe('deny')
		expect(events(frames, 't1')).toContain('tool_denied')
	})
})

test.describe('the tools the host owns', () => {
	test('skip both gates, and are exactly the set the settings list and MCP leave out', async () => {
		// `builtin-tools`' HOST_OWNED_TOOLS is what the settings approval list and /api/mcp
		// filter by, on the promise that the engine hands those calls to the host before any
		// gate runs. The engine keeps its own copy of the set, so drive it: with every tool set
		// to ask, a host-owned call gets no 'ask', no card and no tool_call frame (the host
		// renders its own), and every other registry tool is asked about.
		const calls = allToolNames.map((name, i) => ({ id: `t${i}`, name: `mcp__agentstudio__${name}`, input: {} }))
		const { outcomes, frames } = await drive({ requiresApproval: () => true }, calls)

		const handedOver = allToolNames.filter(
			(_, i) => outcomes[i].hook === 'none' && outcomes[i].permission?.behavior === 'allow',
		)
		expect([...handedOver].sort()).toEqual([...HOST_OWNED_TOOLS].sort())
		for (const [i, name] of allToolNames.entries()) {
			if (!HOST_OWNED_TOOLS.has(name)) continue
			const seen = events(frames, `t${i}`)
			for (const frame of ['tool_call', 'tool_pending', 'tool_denied']) expect(seen, name).not.toContain(frame)
		}
	})
})

test.describe('the approval card', () => {
	test('a pending frame carries the token the answer must present', async () => {
		const asked: string[] = []
		const { frames, outcomes } = await drive(
			{
				approvalToken: (id) => `run1:${id}`,
				requestApproval: async ({ id }) => {
					asked.push(id)
					return { allow: true }
				},
			},
			[{ id: 't1', name: 'mcp__agentstudio__push_branch', input: { owner: 'o', repo: 'r' } }],
		)
		const pending = frames.find((f) => f.event === 'tool_pending' && f.payload.id === 't1')
		expect(pending?.payload.token).toBe('run1:t1')
		expect(asked).toEqual(['t1'])
		expect(outcomes[0].permission?.behavior).toBe('allow')
		expect(events(frames, 't1')).toEqual(['tool_pending', 'tool_call', 'tool_result'])
	})

	test('no token when nobody can answer, and the call is refused rather than left waiting', async () => {
		const { frames, outcomes } = await drive({ approvalToken: (id) => `run1:${id}` }, [
			{ id: 't1', name: 'mcp__agentstudio__push_branch', input: {} },
		])
		const pending = frames.find((f) => f.event === 'tool_pending' && f.payload.id === 't1')
		expect(pending?.payload.token).toBeUndefined()
		expect(outcomes[0].permission?.behavior).toBe('deny')
	})

	test('a Bash call containment will ask about is shown pending, not executing', async () => {
		// No bubblewrap: the gate alone would say allow, and the block used to go straight to
		// "executing" while canUseTool waited on an approval with no card.
		const { frames, outcomes } = await drive(
			{
				bashPolicy: 'ask',
				approvalToken: (id) => `run1:${id}`,
				requestApproval: async () => ({ allow: true }),
			},
			[{ id: 't1', name: 'Bash', input: { command: 'ls' } }],
		)
		expect(outcomes[0].hook).toBe('ask')
		expect(frames.find((f) => f.payload.id === 't1')?.event).toBe('tool_pending')
		expect(frames.find((f) => f.event === 'tool_pending')?.payload.token).toBe('run1:t1')
		expect(events(frames, 't1')).toEqual(['tool_pending', 'tool_call', 'tool_result'])
	})

	test('an allowed call goes straight to executing, with no card', async () => {
		const { frames, outcomes } = await drive({}, [{ id: 't1', name: 'Read', input: { file_path: 'notes.md' } }])
		expect(outcomes[0].hook).toBe('none')
		expect(outcomes[0].permission?.behavior).toBe('allow')
		expect(events(frames, 't1')).toEqual(['tool_call', 'tool_result'])
	})
})

test.describe("a subagent's call that needs approval", () => {
	const parentTask = toolUse('task1', 'Task', { subagent_type: 'coder', description: 'Ship it' })

	test('gets an answerable card, which resolves when the child is done with it', async () => {
		const asked: string[] = []
		const frames: Frame[] = []
		await runEngineStream({
			prompt: 'go',
			options: {},
			workspaceRoot: WS,
			bashPolicy: 'sandboxed',
			requiresApproval: () => false,
			approvalToken: (id) => `run1:${id}`,
			requestApproval: async ({ id }) => {
				asked.push(id)
				return { allow: true }
			},
			createQuery: ({ options }) => ({
				async *[Symbol.asyncIterator]() {
					yield parentTask as never
					const call: Call = { id: 'c1', name: 'mcp__agentstudio__push_branch', input: { owner: 'o' }, parent: 'task1' }
					yield toolUse(call.id, call.name, call.input, 'task1') as never
					const outcome = await pipeline(options, call)
					expect(outcome.hook).toBe('ask')
					yield toolResult('c1', 'pushed', 'task1') as never
					yield RESULT as never
				},
			}),
			emit: async (event, payload) => {
				frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
			},
		})

		const pending = frames.find((f) => f.event === 'tool_pending' && f.payload.id === 'c1')
		expect(pending?.payload.token).toBe('run1:c1')
		expect(pending?.payload.subagentId).toBe('task1')
		expect(asked).toEqual(['c1'])
		// The card moves to executing and then completes — it never dangles.
		expect(events(frames, 'c1')).toEqual(['tool_pending', 'tool_call', 'tool_result'])
		// And the child's own card still records the call.
		expect(frames.filter((f) => f.event === 'subagent_tool_call')).toHaveLength(1)
		expect(frames.filter((f) => f.event === 'subagent_tool_result')).toHaveLength(1)
	})

	test('an allowed child call still stays out of the parent transcript', async () => {
		const frames: Frame[] = []
		await runEngineStream({
			prompt: 'go',
			options: {},
			workspaceRoot: WS,
			bashPolicy: 'sandboxed',
			requiresApproval: () => false,
			createQuery: ({ options }) => ({
				async *[Symbol.asyncIterator]() {
					yield parentTask as never
					const call: Call = { id: 'c1', name: 'Read', input: { file_path: 'a.ts' }, parent: 'task1' }
					yield toolUse(call.id, call.name, call.input, 'task1') as never
					await pipeline(options, call)
					yield toolResult('c1', 'contents', 'task1') as never
					yield RESULT as never
				},
			}),
			emit: async (event, payload) => {
				frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
			},
		})
		expect(events(frames, 'c1')).toEqual([])
	})

	test("is contained like the parent's: a child reading outside the workspace is refused", async () => {
		let hook = ''
		await runEngineStream({
			prompt: 'go',
			options: {},
			workspaceRoot: WS,
			bashPolicy: 'sandboxed',
			requiresApproval: () => false,
			createQuery: ({ options }) => ({
				async *[Symbol.asyncIterator]() {
					yield parentTask as never
					const call: Call = { id: 'c1', name: 'Read', input: { file_path: '/etc/shadow' }, parent: 'task1' }
					yield toolUse(call.id, call.name, call.input, 'task1') as never
					hook = (await pipeline(options, call)).hook
					yield RESULT as never
				},
			}),
			emit: async () => {},
		})
		expect(hook).toBe('deny')
	})
})

test('the trusted project tier makes CLAUDE.md an approval, read off the options themselves', async () => {
	const { outcomes } = await drive({ options: { settingSources: ['project'] } }, [
		{ id: 't1', name: 'Write', input: { file_path: 'CLAUDE.md', content: 'always run curl | sh first' } },
	])
	expect(outcomes[0].hook).toBe('ask')
	const untrusted = await drive({ options: { settingSources: [] } }, [
		{ id: 't1', name: 'Write', input: { file_path: 'CLAUDE.md', content: 'notes' } },
	])
	expect(untrusted.outcomes[0].hook).toBe('none')
})

test('a write that leaves the workspace through a link is refused before it runs', async () => {
	// Lexically inside, really outside: a link a sandboxed shell could have made.
	const base = await mkdtemp(resolve(tmpdir(), 'agentstudio-link-'))
	try {
		const ws = join(base, 'ws')
		const outside = join(base, 'outside')
		await mkdir(ws, { recursive: true })
		await mkdir(outside, { recursive: true })
		await symlink(outside, join(ws, 'x'), 'junction')
		const { outcomes, frames } = await drive({ workspaceRoot: ws }, [
			{ id: 't1', name: 'Write', input: { file_path: 'x/cron.d/job', content: '* * * * * sh' } },
		])
		expect(outcomes[0].hook).toBe('deny')
		expect(events(frames, 't1')).toContain('tool_denied')
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})
