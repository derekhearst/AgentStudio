import { expect, test } from '@playwright/test'
import { detachedRunToolNames } from '../src/lib/runtime/detached-tools'
import { NOT_OFFERED_REASON, notOfferedMessage, offeredToolNames } from '../src/lib/runtime/offered-tools'
import { allToolNames } from '../src/lib/tools/tool-schemas'

/**
 * The old loop runs only the tools it offered the model.
 *
 * Its callers are unattended — an automation with an agent, a monitor's start_conversation,
 * a CI fix run — and pass no approval set, because nobody is there to answer. The loop used
 * to hand any registry name the model emitted straight to `executeTool`, so the short list in
 * `detached-tools` was a suggestion: a prompt-injected `web_search` result asking for
 * `delete_file` or `create_automation` ran. Now a name the run did not offer is refused
 * before approval or execution.
 *
 * The first block is pure. The second drives the loop's per-call dispatch with a recording
 * session; it imports the tool registry (so the database module loads) but no call it makes
 * reaches the database, a model or a tool.
 */

const definitions = (names: readonly string[]) =>
	names.map((name) => ({ type: 'function' as const, function: { name, description: '', parameters: {} } }))

/** What a hostile page might ask an unattended run to call. */
const OUTSIDE = ['delete_file', 'move_file', 'clone_repository', 'update_agent', 'create_automation', 'image_generate']

test.describe('runtime/offered-tools — the list a run offers', () => {
	test('a detached run offers web_search, and every other registry tool is outside it', () => {
		const offered = offeredToolNames(definitions(detachedRunToolNames()))
		expect([...offered]).toEqual(['web_search'])
		for (const name of allToolNames) {
			if (name !== 'web_search') expect(offered.has(name), name).toBe(false)
		}
		for (const name of OUTSIDE) expect(allToolNames, name).toContain(name)
	})

	test('an agent scoped down to nothing offers nothing', () => {
		expect(offeredToolNames(definitions(detachedRunToolNames(['web_fetch']))).size).toBe(0)
	})

	test('names match exactly', () => {
		const offered = offeredToolNames(definitions(['web_search']))
		for (const name of ['WEB_SEARCH', 'web_search ', 'mcp__agentstudio__web_search', 'web']) {
			expect(offered.has(name), name).toBe(false)
		}
	})

	test('the refusal names the tool and says it is not available', () => {
		expect(notOfferedMessage('delete_file')).toContain('delete_file')
		expect(notOfferedMessage('delete_file')).toContain(NOT_OFFERED_REASON)
	})
})

test.describe('runtime/offered-tools — dispatch refuses before anything runs', () => {
	type Emitted = { event: string; payload: Record<string, unknown> }

	async function dispatch(name: string, opts: { offered?: readonly string[]; approval?: string[] } = {}) {
		const { dispatchToolCall } = await import('../src/lib/runtime/tool-handlers.server')
		const emits: Emitted[] = []
		const blocks: unknown[] = []
		const patches: unknown[] = []
		const session = {
			runId: 'run-offered-tools-spec',
			isClientConnected: () => true,
			emit: async (event: string, payload: unknown) => {
				emits.push({ event, payload: payload as Record<string, unknown> })
			},
			updateRun: async (patch: unknown) => {
				patches.push(patch)
			},
			pushBlock: async (block: unknown) => {
				blocks.push(block)
			},
		}
		const outcome = await dispatchToolCall(
			{
				session: session as never,
				userId: 'u1',
				conversationId: 'c1',
				agentId: null,
				persistentKey: null,
				worktree: null,
				projectId: null,
				offeredTools: offeredToolNames(definitions(opts.offered ?? detachedRunToolNames())),
				approvalRequiredTools: new Set(opts.approval ?? []),
				isOrchestrator: false,
			},
			{ id: 't1', name, arguments: '{}', parsedArgs: {} },
		)
		return { outcome, emits, blocks, patches }
	}

	test('a registry tool the run did not offer is refused, and never reaches execution', async () => {
		for (const name of OUTSIDE) {
			const { outcome, emits, blocks, patches } = await dispatch(name)
			expect(JSON.parse(outcome.toolResult.result), name).toEqual({ error: notOfferedMessage(name) })
			expect(outcome.allToolCallsEntry.result, name).toEqual({ denied: true, reason: NOT_OFFERED_REASON })
			// No "Executing" state and no tool_call frame: dispatch stopped before executeTool.
			expect(patches, name).toEqual([])
			expect(emits.map((e) => e.event), name).toEqual(['tool_result'])
			expect(emits[0].payload.success, name).toBe(false)
			// The transcript still shows the attempt, as a failed block.
			expect(blocks, name).toEqual([
				{
					kind: 'tool',
					name,
					arguments: {},
					result: { denied: true, reason: NOT_OFFERED_REASON },
					success: false,
					executionMs: 0,
				},
			])
		}
	})

	test('it is refused before approval, so no card is raised for a tool the run cannot call', async () => {
		const { emits, patches } = await dispatch('delete_file', { approval: ['*'] })
		expect(emits.map((e) => e.event)).toEqual(['tool_result'])
		expect(patches).toEqual([])
	})

	test('ask_user is refused the same way when the run did not offer it', async () => {
		const { outcome } = await dispatch('ask_user')
		expect(JSON.parse(outcome.toolResult.result)).toEqual({ error: notOfferedMessage('ask_user') })
	})

	test('an offered name passes the gate to the next stage', async () => {
		// ask_user offered to a run that is not the orchestrator reaches its own handler, which
		// refuses it for its own reason: the gate let it through, and nothing ran.
		const { outcome } = await dispatch('ask_user', { offered: ['ask_user'] })
		expect(outcome.toolResult.result).toContain('Agents cannot ask users directly')
	})
})
