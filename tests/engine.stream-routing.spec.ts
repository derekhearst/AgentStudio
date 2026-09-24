import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

		// The parent's transcript shows the delegation as the child's card (#32), and neither
		// the delegation nor the child's individual calls as tool calls of the parent's.
		expect(frames.filter((f) => f.event === 'tool_call')).toHaveLength(0)
		expect(frames.filter((f) => f.event === 'subagent_start').map((f) => f.payload.agentId)).toEqual(['task1'])

		expect(frames.filter((f) => f.event === 'subagent_tool_call')).toHaveLength(1)
		expect(frames.filter((f) => f.event === 'subagent_tool_result')).toHaveLength(1)

		// Neither the delegation nor the child's `Read` opened a tool block in the parent.
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

test.describe('background commands (#35)', () => {
	/*
	 * A backgrounded `Bash` returns at once with a task id and keeps running. The engine tails
	 * the CLI's output file for it — a real file here, written by the spec while the scripted
	 * stream is paused — and settles the card when the task does, or when the turn ends first.
	 */
	const SESSION = '0f6d3c1e-5a4b-4c2d-9e8f-123456789abc'
	const INIT = { type: 'system', subtype: 'init', session_id: SESSION }

	function outputFile(taskId: string, session = SESSION) {
		const root = mkdtempSync(join(tmpdir(), 'as-bg-shell-'))
		const dir = join(root, session, 'tasks')
		mkdirSync(dir, { recursive: true })
		return { root, file: join(dir, `${taskId}.output`) }
	}

	/** The CLI's backgrounded Bash result: its template text, and a `BashOutput` with the task id. */
	function backgroundResult(id: string, taskId: string, file: string, parent: string | null = null) {
		return {
			type: 'user',
			parent_tool_use_id: parent,
			tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId },
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: id,
						content: `Command running in background with ID: ${taskId}. Output is being written to: ${file}. You will be notified when it completes. To check interim output, use Read on that file path.`,
					},
				],
			},
		}
	}

	function notification(taskId: string, toolUseId: string, status: string, file: string, summary: string) {
		return {
			type: 'system',
			subtype: 'task_notification',
			task_id: taskId,
			tool_use_id: toolUseId,
			status,
			output_file: file,
			summary,
		}
	}

	type Step = unknown | ((frames: Frame[]) => Promise<unknown>)

	/** Run a script whose function steps pause the stream; frames are snapshots, not live objects. */
	async function runGated(steps: Step[]) {
		const frames: Frame[] = []
		const summary = await runEngineStream({
			prompt: 'go',
			options: {},
			backgroundOutputPollMs: 20,
			requiresApproval: () => false,
			createQuery: () => ({
				async *[Symbol.asyncIterator]() {
					for (const step of steps) {
						if (typeof step === 'function') await (step as (frames: Frame[]) => Promise<unknown>)(frames)
						else yield step as never
					}
				},
			}),
			emit: async (event, payload) => {
				frames.push({ event, payload: JSON.parse(JSON.stringify(payload ?? {})) })
			},
		})
		return { frames, summary }
	}

	const shellOutput = (frames: Frame[]) => frames.filter((f) => f.event === 'shell_output')
	const streamedText = (frames: Frame[]) =>
		shellOutput(frames)
			.map((f) => String(f.payload.chunk))
			.join('')
	const waitForOutput = (text: string) => async (frames: Frame[]) => {
		await expect.poll(() => streamedText(frames), { timeout: 10_000 }).toContain(text)
	}
	const pause = (ms: number) => () => new Promise((resolve) => setTimeout(resolve, ms))
	const toolBlock = (blocks: StreamBlock[]) =>
		blocks.find((b): b is Extract<StreamBlock, { kind: 'tool' }> => b.kind === 'tool')

	test('output streams into the card while it runs, and the notification settles it', async () => {
		const { root, file } = outputFile('b1')
		try {
			const { frames, summary } = await runGated([
				INIT,
				toolUse('bg1', 'Bash', { command: 'npm run dev', run_in_background: true }),
				backgroundResult('bg1', 'b1', file),
				async (f: Frame[]) => {
					appendFileSync(file, 'ready on :5173\n')
					await waitForOutput('ready on :5173')(f)
				},
				async (f: Frame[]) => {
					appendFileSync(file, 'compiled\n')
					await waitForOutput('compiled')(f)
				},
				notification('b1', 'bg1', 'completed', file, 'Background command "npm run dev" completed (exit code 0)'),
				RESULT,
			])

			// The card opens live: its result frame already says so.
			const result = frames.find((f) => f.event === 'tool_result')
			expect((result?.payload.details as { background?: unknown } | undefined)?.background).toEqual({
				status: 'running',
			})

			// Keyed on the call, in order, the first one starting the card over.
			const live = shellOutput(frames)
			expect(live.every((f) => f.payload.id === 'bg1' && f.payload.taskId === 'b1')).toBe(true)
			expect(live[0].payload.reset).toBe(true)
			expect(streamedText(frames)).toBe('ready on :5173\ncompiled\n')

			// The first output is also saved at once, for a page that reconnects; the rest waits
			// for the next save a few seconds on, which this turn ends before.
			const saved = frames.filter((f) => f.event === 'shell_output_checkpoint')
			expect(saved.length).toBeGreaterThanOrEqual(1)
			expect(saved[0].payload).toMatchObject({ id: 'bg1', taskId: 'b1', chunk: 'ready on :5173\n', reset: true })

			const done = frames.filter((f) => f.event === 'shell_task_done')
			expect(done).toHaveLength(1)
			expect(done[0].payload).toMatchObject({
				id: 'bg1',
				taskId: 'b1',
				status: 'completed',
				exitCode: 0,
				stdout: 'ready on :5173\ncompiled\n',
			})

			// The persisted block ends where the card did.
			const tool = toolBlock(summary.blocks)
			expect(tool?.details?.kind).toBe('shell')
			if (tool?.details?.kind !== 'shell') return
			expect(tool.details.stdout).toBe('ready on :5173\ncompiled\n')
			expect(tool.details.background).toEqual({ status: 'completed' })
			expect(tool.details.exitCode).toBe(0)
			// Settled in time, so the turn has nothing to say about it ending.
			expect(frames.some((f) => f.event === 'notice' && /turn ended/.test(String(f.payload.title)))).toBe(false)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a command still running when the turn ends is marked so, with one notice', async () => {
		const { root, file } = outputFile('b1')
		try {
			const { frames, summary } = await runGated([
				INIT,
				toolUse('bg1', 'Bash', { command: 'npm run dev', run_in_background: true }),
				backgroundResult('bg1', 'b1', file),
				async (f: Frame[]) => {
					appendFileSync(file, 'listening\n')
					await waitForOutput('listening')(f)
				},
				// Written just before the reply ends; the final read still has it.
				async () => appendFileSync(file, 'last words\n'),
				RESULT,
			])

			const done = frames.filter((f) => f.event === 'shell_task_done')
			expect(done).toHaveLength(1)
			expect(done[0].payload).toMatchObject({ id: 'bg1', status: 'ended_with_turn', exitCode: null })
			expect(String(done[0].payload.stdout)).toBe('listening\nlast words\n')

			const notices = summary.blocks.filter((b) => b.kind === 'notice')
			expect(notices).toHaveLength(1)
			expect(notices[0].kind === 'notice' && notices[0].notice).toMatchObject({
				title: 'A background command was stopped when the turn ended',
				detail: 'npm run dev',
				persist: true,
			})

			const tool = toolBlock(summary.blocks)
			expect(tool?.details?.kind === 'shell' && tool.details.background).toEqual({ status: 'ended_with_turn' })
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a notification that arrives before its result settles the card, not the end of the turn', async () => {
		// The CLI emits `task_notification` the moment a task ends, and a command that fails at
		// once can end before its call's result is written out.
		const { root, file } = outputFile('b1')
		try {
			writeFileSync(file, 'bash: nmp: command not found\n')
			const { frames, summary } = await runGated([
				INIT,
				toolUse('bg1', 'Bash', { command: 'nmp run dev', run_in_background: true }),
				notification('b1', 'bg1', 'failed', file, 'Background command "nmp run dev" failed with exit code 127'),
				backgroundResult('bg1', 'b1', file),
				pause(80),
				RESULT,
			])

			// The card opens settled: its result frame already says how it ended.
			const result = frames.find((f) => f.event === 'tool_result')
			expect(result?.payload.details).toMatchObject({
				background: { status: 'failed' },
				exitCode: 127,
				stdout: 'bash: nmp: command not found\n',
			})
			expect(shellOutput(frames)).toHaveLength(0)
			expect(frames.filter((f) => f.event === 'shell_task_done')).toHaveLength(0)
			// Not "stopped when the turn ended": it had finished.
			expect(frames.some((f) => f.event === 'notice' && /turn ended/.test(String(f.payload.title)))).toBe(false)

			const tool = toolBlock(summary.blocks)
			expect(tool?.details?.kind === 'shell' && tool.details.background).toEqual({ status: 'failed' })
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("a subagent's background command is left to the subagent", async () => {
		const { root, file } = outputFile('b2')
		try {
			writeFileSync(file, 'child output\n')
			const { frames, summary } = await runGated([
				INIT,
				toolUse('task1', 'Task', { subagent_type: 'reviewer' }),
				toolUse('c1', 'Bash', { command: 'sleep 60', run_in_background: true }, 'task1'),
				backgroundResult('c1', 'b2', file, 'task1'),
				pause(120),
				RESULT,
			])

			expect(shellOutput(frames)).toHaveLength(0)
			expect(frames.filter((f) => f.event === 'shell_task_done')).toHaveLength(0)
			expect(summary.blocks.filter((b) => b.kind === 'notice')).toHaveLength(0)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("a path outside this session's tree is never read, and the card still settles", async () => {
		// The file exists and has output, but under another session's directory: neither the
		// result's path nor the notification's may be read.
		const { root, file } = outputFile('b1', 'someone-elses-session')
		try {
			writeFileSync(file, 'not yours\n')
			const { frames, summary } = await runGated([
				INIT,
				toolUse('bg1', 'Bash', { command: 'make test', run_in_background: true }),
				backgroundResult('bg1', 'b1', file),
				pause(120),
				notification('b1', 'bg1', 'failed', file, 'Background command "make test" failed with exit code 2'),
				RESULT,
			])

			expect(shellOutput(frames)).toHaveLength(0)
			const done = frames.find((f) => f.event === 'shell_task_done')
			expect(done?.payload).toMatchObject({ status: 'failed', exitCode: 2, stdout: '' })
			const tool = toolBlock(summary.blocks)
			expect(tool?.details?.kind === 'shell' && tool.details.stdout).toBe('')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("the notification's own path gives a final read when the result named none", async () => {
		const { root, file } = outputFile('b1')
		try {
			writeFileSync(file, 'built in 3s\n')
			const { frames } = await runGated([
				INIT,
				toolUse('bg1', 'Bash', { command: 'bun run build', run_in_background: true }),
				// A result with the task id but no template text to read a path from.
				{
					type: 'user',
					tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
					message: { content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Started.' }] },
				},
				notification('b1', 'bg1', 'completed', file, 'Background command "bun run build" completed (exit code 0)'),
				RESULT,
			])

			const done = frames.find((f) => f.event === 'shell_task_done')
			expect(done?.payload).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'built in 3s\n' })
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
