import { expect, test } from '@playwright/test'
import { runEngineStream, type EngineQuerySource } from '../src/lib/engine/stream.server'
import type { StreamBlock } from '../src/lib/runs/runs.schema'

/**
 * The engine loop, driven with a scripted SDK message stream.
 *
 * Everything the engine knows about a run arrives as `SDKMessage`s, and until `query()`
 * became injectable none of that reading could be tested: the typed tool results
 * (`tool-result-details`), the notices (`sdk-notices`), and the `parent_tool_use_id`
 * routing were all inferred from the SDK's contract and verified only by not breaking the
 * parent path. This drives the real loop over synthetic messages and asserts what comes out.
 *
 * Needs a database only because `stream.server.ts` transitively imports the tool registry;
 * nothing here touches one.
 */

type Frame = { event: string; payload: Record<string, unknown> }

/** A scripted stream. Control methods are absent on purpose — a double has nothing to control. */
function scripted(messages: unknown[]): EngineQuerySource {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) yield message as never
		},
	}
}

async function run(messages: unknown[]) {
	const frames: Frame[] = []
	const summary = await runEngineStream({
		prompt: 'go',
		options: {},
		createQuery: () => scripted(messages),
		// Auto-allow, so a call emits `tool_call` rather than parking as `tool_pending`.
		// The gate has its own spec; these tests are about where a frame is routed.
		requiresApproval: () => false,
		emit: async (event, payload) => {
			frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
		},
	})
	return { frames, summary }
}

/** Shorthand for a completed run so the loop exits with a summary. */
const RESULT = { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 }

function textDelta(text: string, parent: string | null = null) {
	return {
		type: 'stream_event',
		parent_tool_use_id: parent,
		event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
	}
}

function toolUse(id: string, name: string, input: unknown, parent: string | null = null) {
	return {
		type: 'assistant',
		parent_tool_use_id: parent,
		message: { content: [{ type: 'tool_use', id, name, input }] },
	}
}

function toolResult(id: string, text: string, parent: string | null = null, structured?: unknown) {
	return {
		type: 'user',
		parent_tool_use_id: parent,
		tool_use_result: structured,
		message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
	}
}

test.describe('the parent path', () => {
	test('text deltas become the reply and one coalesced block', async () => {
		const { frames, summary } = await run([textDelta('Hello '), textDelta('world'), RESULT])

		expect(summary.text).toBe('Hello world')
		expect(frames.filter((f) => f.event === 'delta').map((f) => f.payload.content)).toEqual([
			'Hello ',
			'world',
		])
		expect(summary.blocks).toHaveLength(1)
		expect(summary.blocks[0]).toEqual({ kind: 'text', content: 'Hello world' })
	})

	test('a typed tool result reaches the block as details', async () => {
		// The whole point of reading `tool_use_result` — the diff is computed by the SDK and
		// was previously discarded in favour of the text the model reads.
		const { summary } = await run([
			toolUse('t1', 'Edit', { file_path: '/w/a.ts' }),
			toolResult('t1', 'ok', null, {
				filePath: '/w/a.ts',
				originalFile: 'a',
				structuredPatch: [
					{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
				],
			}),
			RESULT,
		])

		const tool = summary.blocks.find((b): b is Extract<StreamBlock, { kind: 'tool' }> => b.kind === 'tool')
		expect(tool?.details?.kind).toBe('file_edit')
		expect(tool?.details?.kind === 'file_edit' && tool.details.path).toBe('/w/a.ts')
		expect(tool?.details?.kind === 'file_edit' && tool.details.additions).toBe(1)
		expect(tool?.details?.kind === 'file_edit' && tool.details.deletions).toBe(1)
	})

	test('a compaction boundary becomes a persisted notice; a retry does not', async () => {
		const { frames, summary } = await run([
			{
				type: 'system',
				subtype: 'compact_boundary',
				compact_metadata: { trigger: 'auto', pre_tokens: 100, post_tokens: 10 },
			},
			{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, error_status: 529 },
			RESULT,
		])

		expect(frames.filter((f) => f.event === 'notice')).toHaveLength(2)
		// Only the one that still means something after the turn is kept.
		const notices = summary.blocks.filter((b) => b.kind === 'notice')
		expect(notices).toHaveLength(1)
		expect(notices[0].kind === 'notice' && notices[0].notice.kind).toBe('compacted')
	})
})

test.describe('subagent routing (#5)', () => {
	test("a child's text never becomes the parent's reply", async () => {
		// The defect this routing exists to prevent: a delegated agent's prose read as the
		// parent's own answer, which is what gets persisted as the assistant message.
		const { frames, summary } = await run([
			toolUse('task1', 'Task', { subagent_type: 'reviewer', description: 'Review it' }),
			textDelta('parent says'),
			textDelta('child says', 'task1'),
			RESULT,
		])

		expect(summary.text).toBe('parent says')
		expect(summary.text).not.toContain('child says')

		// And it is not silently dropped — it goes to the child.
		const childDeltas = frames.filter((f) => f.event === 'subagent_delta')
		expect(childDeltas).toHaveLength(1)
		expect(childDeltas[0].payload.content).toBe('child says')

		const child = summary.blocks.find((b) => b.kind === 'subagent')
		expect(child?.kind === 'subagent' && child.content).toBe('child says')
		expect(child?.kind === 'subagent' && child.agentName).toBe('reviewer')
		expect(child?.kind === 'subagent' && child.task).toBe('Review it')
	})

	test("a child's tool call is not the parent's", async () => {
		const { frames, summary } = await run([
			toolUse('task1', 'Task', { subagent_type: 'reviewer' }),
			toolUse('c1', 'Read', { file_path: '/w/a.ts' }, 'task1'),
			toolResult('c1', 'contents', 'task1'),
			RESULT,
		])

		// The parent's transcript shows the delegation, not the child's individual calls.
		const parentToolFrames = frames.filter((f) => f.event === 'tool_call')
		expect(parentToolFrames.map((f) => f.payload.name)).toEqual(['Task'])

		expect(frames.filter((f) => f.event === 'subagent_tool_call')).toHaveLength(1)
		expect(frames.filter((f) => f.event === 'subagent_tool_result')).toHaveLength(1)

		// The parent's `Task` has no result in this script, so it closes no tool block — and
		// the child's `Read`, which does have one, did not open a block in the parent either.
		const toolBlocks = summary.blocks.filter((b) => b.kind === 'tool')
		expect(toolBlocks).toHaveLength(0)
		expect(summary.blocks.filter((b) => b.kind === 'subagent')).toHaveLength(1)
	})

	test('the ledger still counts a child call — it is work this run did', async () => {
		const seen: string[] = []
		const frames: Frame[] = []
		await runEngineStream({
			prompt: 'go',
			options: {},
			createQuery: () =>
				scripted([
					toolUse('task1', 'Task', { subagent_type: 'reviewer' }),
					toolUse('c1', 'Read', { file_path: '/w/a.ts' }, 'task1'),
					toolResult('c1', 'contents', 'task1'),
					RESULT,
				]),
			onToolResult: ({ name }) => seen.push(name),
			emit: async (event, payload) => {
				frames.push({ event, payload: (payload ?? {}) as Record<string, unknown> })
			},
		})

		expect(seen).toContain('Read')
	})

	test('the Task result closes the child', async () => {
		const { frames, summary } = await run([
			toolUse('task1', 'Task', { subagent_type: 'reviewer' }),
			toolUse('c1', 'Read', {}, 'task1'),
			toolResult('c1', 'ok', 'task1'),
			toolResult('task1', 'done'),
			RESULT,
		])

		expect(frames.filter((f) => f.event === 'subagent_done')).toHaveLength(1)
		const child = summary.blocks.find((b) => b.kind === 'subagent')
		expect(child?.kind === 'subagent' && child.success).toBe(true)
	})

	test('a failed child call marks the child failed, not the parent', async () => {
		const { summary } = await run([
			toolUse('task1', 'Task', { subagent_type: 'reviewer' }),
			{
				type: 'user',
				parent_tool_use_id: 'task1',
				message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }] },
			},
			RESULT,
		])

		const child = summary.blocks.find((b) => b.kind === 'subagent')
		expect(child?.kind === 'subagent' && child.success).toBe(false)
	})

	test('a child\'s tool result is reported as the child\'s (#133)', async () => {
		// The ledger counts both, but the pinned checklist must only ever take the parent's
		// `TodoWrite` — so the caller has to be able to tell them apart.
		const todos = { newTodos: [{ content: 'child step', status: 'pending', activeForm: 'Doing the child step' }] }
		const seen: Array<{ name: string; subagentId?: string; kind?: string }> = []
		await runEngineStream({
			prompt: 'go',
			options: {},
			createQuery: () =>
				scripted([
					toolUse('task1', 'Task', { subagent_type: 'reviewer' }),
					toolUse('c1', 'TodoWrite', {}, 'task1'),
					toolResult('c1', 'ok', 'task1', todos),
					toolUse('p1', 'TodoWrite', {}),
					toolResult('p1', 'ok', null, todos),
					RESULT,
				]),
			requiresApproval: () => false,
			onToolResult: ({ name, subagentId, details }) => seen.push({ name, subagentId, kind: details?.kind }),
			emit: async () => {},
		})

		expect(seen).toEqual([
			{ name: 'TodoWrite', subagentId: 'task1', kind: 'todo' },
			{ name: 'TodoWrite', subagentId: undefined, kind: 'todo' },
		])
	})
})
