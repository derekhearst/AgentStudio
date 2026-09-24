import { expect, test } from '@playwright/test'
import type { HookCallbackMatcher, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { runEngineStream, type EngineRunInput, type EngineQuerySource } from '../src/lib/engine/stream.server'
import { buildRunMcpConnectors, type McpProvenance } from '../src/lib/engine/mcp-connectors'

/**
 * #17 — a connector's tools through the engine, driven the way the SDK drives it.
 *
 * The scripted stream plays the SDK: it announces a call, runs the permission pipeline the
 * CLI runs — the PreToolUse hook with the call's `mcp_server` provenance, then `canUseTool`
 * with `mcpServer` when the hook asks or says nothing — and answers it. Same arrangement as
 * `engine.stream-approvals.spec.ts`, plus the provenance the SDK reports for MCP tools.
 *
 * What this pins: a blocked tool never runs and never asks; an allowed tool runs without a
 * card; an ask tool gets the approval card with its token; a server that is not one of the
 * run's connectors, or whose provenance disagrees with the row, is refused before anything
 * else; and a call the SDK gives no provenance for is asked about rather than run unasked.
 *
 * Needs a database only because `stream.server.ts` transitively imports the tool registry.
 */

type Frame = { event: string; payload: Record<string, unknown> }
type Call = { id: string; name: string; input: Record<string, unknown>; provenance: McpProvenance | null }
type Outcome = { hook: string; permission: PermissionResult | null }

const WS = process.platform === 'win32' ? 'C:\\sandbox\\u1\\runs\\r1' : '/sandbox/u1/runs/r1'
const RESULT = { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 }
const DYNAMIC = (name: string): McpProvenance => ({ name, source: 'dynamic' })

const CONNECTORS = buildRunMcpConnectors([
	{ id: 'row-github', name: 'github', toolPolicies: { search_issues: 'allow', delete_repo: 'block' } },
])

async function pipeline(options: Options, call: Call): Promise<Outcome> {
	let hook = 'none'
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
					...(call.provenance ? { mcp_server: call.provenance } : {}),
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
		...(call.provenance ? { mcpServer: call.provenance } : {}),
	})
	return { hook, permission }
}

async function drive(input: Partial<EngineRunInput>, calls: Call[]) {
	const frames: Frame[] = []
	const outcomes: Outcome[] = []
	const approvals: string[] = []
	await runEngineStream({
		prompt: 'go',
		options: {},
		workspaceRoot: WS,
		bashPolicy: 'sandboxed',
		requiresApproval: () => false,
		mcpConnectors: CONNECTORS,
		approvalToken: (id) => `run1:${id}`,
		requestApproval: async ({ name }) => {
			approvals.push(name)
			return { allow: true }
		},
		...input,
		createQuery: ({ options }): EngineQuerySource => ({
			async *[Symbol.asyncIterator]() {
				for (const call of calls) {
					yield {
						type: 'assistant',
						parent_tool_use_id: null,
						message: { content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
					} as never
					const outcome = await pipeline(options, call)
					outcomes.push(outcome)
					const allowed = outcome.permission?.behavior === 'allow'
					yield {
						type: 'user',
						parent_tool_use_id: null,
						message: {
							content: [{ type: 'tool_result', tool_use_id: call.id, content: allowed ? 'ok' : 'refused', is_error: !allowed }],
						},
					} as never
				}
				yield RESULT as never
			},
		}),
		emit: async (event, payload) => {
			frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
		},
	})
	return { frames, outcomes, approvals }
}

const events = (frames: Frame[], id: string) => frames.filter((f) => f.payload.id === id).map((f) => f.event)

test.describe('a connector’s tools through the engine', () => {
	test('an allowed tool runs with no approval card', async () => {
		const { frames, outcomes, approvals } = await drive({}, [
			{ id: 't1', name: 'mcp__github__search_issues', input: { q: 'bug' }, provenance: DYNAMIC('github') },
		])
		expect(outcomes[0].hook).toBe('none')
		expect(outcomes[0].permission?.behavior).toBe('allow')
		expect(approvals).toEqual([])
		expect(events(frames, 't1')).not.toContain('tool_pending')
		expect(events(frames, 't1')).toContain('tool_call')
	})

	test('a blocked tool is refused by the hook and never asks', async () => {
		const { frames, outcomes, approvals } = await drive({ permissionMode: 'bypassPermissions' }, [
			{ id: 't1', name: 'mcp__github__delete_repo', input: {}, provenance: DYNAMIC('github') },
		])
		expect(outcomes[0].hook).toBe('deny')
		expect(approvals).toEqual([])
		expect(events(frames, 't1').slice(0, 2)).toEqual(['tool_pending', 'tool_denied'])
	})

	test('a tool with no policy gets the approval card, with its token', async () => {
		const { frames, outcomes, approvals } = await drive({}, [
			{ id: 't1', name: 'mcp__github__create_issue', input: { title: 'x' }, provenance: DYNAMIC('github') },
		])
		expect(outcomes[0].hook).toBe('ask')
		expect(approvals).toEqual(['mcp__github__create_issue'])
		expect(outcomes[0].permission?.behavior).toBe('allow')
		const pending = frames.find((f) => f.event === 'tool_pending' && f.payload.id === 't1')
		expect(pending?.payload.token).toBe('run1:t1')
	})

	test('a server that is not one of the run’s connectors is refused', async () => {
		const { outcomes, approvals } = await drive({ permissionMode: 'bypassPermissions' }, [
			{ id: 't1', name: 'mcp__intruder__search_issues', input: {}, provenance: DYNAMIC('intruder') },
		])
		expect(outcomes[0].hook).toBe('deny')
		expect(approvals).toEqual([])
	})

	test('provenance that disagrees with the row is refused, even for an allowed tool', async () => {
		const { outcomes } = await drive({}, [
			{ id: 't1', name: 'mcp__github__search_issues', input: {}, provenance: { name: 'github', source: 'project' } },
		])
		expect(outcomes[0].hook).toBe('deny')
	})

	test('with no provenance reported, an allowed tool is asked about, not run unasked', async () => {
		const { outcomes, approvals } = await drive({}, [
			{ id: 't1', name: 'mcp__github__search_issues', input: {}, provenance: null },
		])
		expect(outcomes[0].hook).toBe('ask')
		expect(approvals).toEqual(['mcp__github__search_issues'])
	})

	test('plan mode refuses an allowed connector tool', async () => {
		const { outcomes } = await drive({ permissionMode: 'plan' }, [
			{ id: 't1', name: 'mcp__github__search_issues', input: {}, provenance: DYNAMIC('github') },
		])
		expect(outcomes[0].hook).toBe('deny')
	})
})
