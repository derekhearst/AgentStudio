import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createBackgroundShells, type ShellOutputFrame } from '../src/lib/engine/background-shells.server'
import type { tailTaskOutput } from '../src/lib/engine/task-output.server'
import type { ShellDetails } from '../src/lib/engine/tool-result-details'
import { applyShellOutput, type StreamingBlock } from '../src/lib/chat/streaming-blocks'

/**
 * #35 — following a background command: what is sent, what is saved, and what can never hold
 * up the end of a turn.
 *
 * `createBackgroundShells` is driven directly, against real output files, with `emit`
 * recorded. The engine's side of it (which SDK message calls what) is
 * `engine.stream-routing.spec.ts`; the page's side is `chat.shell-output.spec.ts`.
 */

const SESSION = '0f6d3c1e-5a4b-4c2d-9e8f-123456789abc'

type Frame = { event: string; payload: Record<string, unknown> }

function outputFile(taskId: string) {
	const root = mkdtempSync(join(tmpdir(), 'as-bg-shells-'))
	const dir = join(root, SESSION, 'tasks')
	mkdirSync(dir, { recursive: true })
	return { root, file: join(dir, `${taskId}.output`) }
}

/** The CLI's backgrounded Bash result text. */
const template = (taskId: string, file: string) =>
	`Command running in background with ID: ${taskId}. Output is being written to: ${file}. You will be notified when it completes.`

function shellDetails(taskId: string, command = 'npm run dev'): ShellDetails {
	return {
		kind: 'shell',
		tool: 'Bash',
		command,
		description: null,
		stdout: '',
		stderr: '',
		interrupted: false,
		backgroundTaskId: taskId,
		timedOutAfterMs: null,
		persistedOutputPath: null,
		truncated: false,
	}
}

function recorder() {
	const frames: Frame[] = []
	return {
		frames,
		emit: async (event: string, payload: unknown) => {
			frames.push({ event, payload: JSON.parse(JSON.stringify(payload ?? {})) })
		},
		of: (event: string) => frames.filter((f) => f.event === event),
		text: (event: string) =>
			frames
				.filter((f) => f.event === event)
				.map((f) => String(f.payload.chunk))
				.join(''),
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The card as the `tool_result` frame creates it, before any output. */
function card(details: ShellDetails): StreamingBlock[] {
	return [
		{
			kind: 'tool',
			id: 'bg1',
			name: 'Bash',
			arguments: '{}',
			status: 'completed',
			expanded: true,
			details: JSON.parse(JSON.stringify(details)),
		},
	]
}

function stdoutOf(blocks: StreamingBlock[]) {
	const block = blocks[0]
	if (block.kind !== 'tool' || block.details?.kind !== 'shell') throw new Error('not a shell block')
	return { stdout: block.details.stdout, truncated: block.details.truncated }
}

test.describe('saved output, for a page that reconnects mid-turn', () => {
	test('each new piece is saved, and a page that sees only saved frames builds the same card', async () => {
		const { root, file } = outputFile('b1')
		const rec = recorder()
		const shells = createBackgroundShells({ emit: rec.emit, pollMs: 15, checkpointMs: 0 })
		const details = shellDetails('b1')
		try {
			await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details })
			const initial = card(details)

			for (const line of ['one\n', 'two\n', 'three\n']) {
				appendFileSync(file, line)
				await expect.poll(() => rec.text('shell_output_checkpoint')).toContain(line)
			}
			// Polls that find nothing new save nothing.
			const saved = rec.of('shell_output_checkpoint').length
			await sleep(80)
			expect(rec.of('shell_output_checkpoint')).toHaveLength(saved)
			expect(rec.text('shell_output_checkpoint')).toBe('one\ntwo\nthree\n')

			// A connected page gets every frame, live and saved; a reloaded one only the saved.
			const everything = rec.frames.filter((f) => f.event === 'shell_output' || f.event === 'shell_output_checkpoint')
			const connected = everything.reduce(
				(blocks, f) => applyShellOutput(blocks, f.payload as ShellOutputFrame),
				initial,
			)
			const reloaded = rec
				.of('shell_output_checkpoint')
				.reduce((blocks, f) => applyShellOutput(blocks, f.payload as ShellOutputFrame), initial)
			expect(stdoutOf(connected)).toEqual({ stdout: 'one\ntwo\nthree\n', truncated: false })
			expect(stdoutOf(reloaded)).toEqual({ stdout: 'one\ntwo\nthree\n', truncated: false })
		} finally {
			await shells.endTurn()
			await shells.stopAll()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('saves are spaced out, and each carries everything since the one before', async () => {
		const { root, file } = outputFile('b1')
		const rec = recorder()
		const shells = createBackgroundShells({ emit: rec.emit, pollMs: 15, checkpointMs: 1_000 })
		try {
			await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details: shellDetails('b1') })

			// The first output is saved at once, so a reload early on is not left with nothing.
			appendFileSync(file, 'one\n')
			await expect.poll(() => rec.of('shell_output_checkpoint').length).toBe(1)

			// More output inside the interval goes out live, and waits to be saved.
			appendFileSync(file, 'two\n')
			await expect.poll(() => rec.text('shell_output')).toContain('two\n')
			appendFileSync(file, 'three\n')
			await expect.poll(() => rec.text('shell_output')).toContain('three\n')
			expect(rec.of('shell_output_checkpoint')).toHaveLength(1)

			await expect.poll(() => rec.of('shell_output_checkpoint').length, { timeout: 5_000 }).toBe(2)
			expect(rec.of('shell_output_checkpoint')[1].payload).toMatchObject({
				id: 'bg1',
				taskId: 'b1',
				chunk: 'two\nthree\n',
				reset: false,
				from: 4,
				to: 14,
			})
		} finally {
			await shells.endTurn()
			await shells.stopAll()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a file that starts over is saved as a reset', async () => {
		const { root, file } = outputFile('b1')
		const rec = recorder()
		const shells = createBackgroundShells({ emit: rec.emit, pollMs: 15, checkpointMs: 0 })
		const details = shellDetails('b1')
		try {
			await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details })
			const initial = card(details)
			appendFileSync(file, 'a long first line\n')
			await expect.poll(() => rec.of('shell_output_checkpoint').length).toBe(1)
			writeFileSync(file, 'new\n')
			await expect.poll(() => rec.of('shell_output_checkpoint').length).toBe(2)
			expect(rec.of('shell_output_checkpoint')[1].payload).toMatchObject({ chunk: 'new\n', reset: true, from: 0, to: 4 })

			const reloaded = rec
				.of('shell_output_checkpoint')
				.reduce((blocks, f) => applyShellOutput(blocks, f.payload as ShellOutputFrame), initial)
			expect(stdoutOf(reloaded).stdout).toBe('new\n')
		} finally {
			await shells.endTurn()
			await shells.stopAll()
			rmSync(root, { recursive: true, force: true })
		}
	})
})

test.describe('a notification that arrives before its result', () => {
	test('creates the card settled, with its exit code and output, instead of running', async () => {
		// A command that fails at once can end before the CLI writes its call's result out.
		const { root, file } = outputFile('b1')
		const rec = recorder()
		const shells = createBackgroundShells({ emit: rec.emit, pollMs: 15 })
		const details = shellDetails('b1', 'nmp run dev')
		try {
			writeFileSync(file, 'bash: nmp: command not found\n')
			await shells.settle({ taskId: 'b1', toolUseId: 'bg1', status: 'failed', outputFile: file, exitCode: 127 })
			expect(rec.frames).toEqual([])

			await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details })
			expect(details.background).toEqual({ status: 'failed' })
			expect(details.exitCode).toBe(127)
			expect(details.stdout).toBe('bash: nmp: command not found\n')
			// Nothing is sent from here: the `tool_result` frame that follows carries all of it.
			expect(rec.frames).toEqual([])

			// Nothing is still running, so the turn has nothing to say when it ends.
			await sleep(60)
			expect(await shells.endTurn()).toBeNull()
			expect(rec.frames).toEqual([])
		} finally {
			await shells.stopAll()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("is matched by the call's id too, and reads the notification's path when the result names none", async () => {
		const { root, file } = outputFile('b1')
		const rec = recorder()
		const shells = createBackgroundShells({ emit: rec.emit, pollMs: 15 })
		const details = shellDetails('b1', 'ls')
		try {
			writeFileSync(file, 'README.md\n')
			// Held under another task id: only the call id ties it to this command.
			await shells.settle({ taskId: 'x9', toolUseId: 'bg1', status: 'completed', outputFile: file, exitCode: 0 })
			await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: 'Started.', details })
			expect(details.background).toEqual({ status: 'completed' })
			expect(details.exitCode).toBe(0)
			// Checked against this command's own session and task id, which it matches.
			expect(details.stdout).toBe('README.md\n')
		} finally {
			await shells.endTurn()
			await shells.stopAll()
			rmSync(root, { recursive: true, force: true })
		}
	})
})

test.describe('the end of a turn is never held up', () => {
	/** A tail whose reads never come back, and a way to deliver one late anyway. */
	function stuckTail() {
		const late: Array<(text: string) => Promise<void>> = []
		const factory: typeof tailTaskOutput = (opts) => {
			late.push(async (text) => {
				await opts.onChunk(text, { reset: false, skipped: false })
			})
			return { finish: () => new Promise(() => {}), stop: () => new Promise(() => {}) }
		}
		return { factory, late }
	}

	test('a final read that never returns is abandoned, and a late one changes nothing', async () => {
		const rec = recorder()
		const { factory, late } = stuckTail()
		const shells = createBackgroundShells({ emit: rec.emit, tail: factory, finishTimeoutMs: 50 })
		const file = join(tmpdir(), SESSION, 'tasks', 'b1.output')
		const details = shellDetails('b1')
		await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details })
		expect(late).toHaveLength(1)

		const started = Date.now()
		const notice = await shells.endTurn()
		expect(Date.now() - started).toBeLessThan(1_500)
		expect(notice?.title).toBe('A background command was stopped when the turn ended')
		expect(rec.of('shell_task_done').map((f) => f.payload.status)).toEqual(['ended_with_turn'])

		// Stopping is bounded the same way.
		await shells.stopAll()

		const sent = rec.frames.length
		await late[0]('too late\n')
		expect(details.stdout).toBe('')
		expect(rec.frames).toHaveLength(sent)
	})

	test('a notification whose final read never returns still settles the card', async () => {
		const rec = recorder()
		const { factory } = stuckTail()
		const shells = createBackgroundShells({ emit: rec.emit, tail: factory, finishTimeoutMs: 50 })
		const file = join(tmpdir(), SESSION, 'tasks', 'b1.output')
		await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details: shellDetails('b1') })
		await shells.settle({ taskId: 'b1', toolUseId: 'bg1', status: 'completed', outputFile: file, exitCode: 0 })
		expect(rec.of('shell_task_done').map((f) => f.payload)).toEqual([
			expect.objectContaining({ status: 'completed', exitCode: 0 }),
		])
		expect(await shells.endTurn()).toBeNull()
		await shells.stopAll()
	})

	test('a named pipe in place of the output file does not stall the end of the turn', async () => {
		test.skip(process.platform === 'win32', 'named pipes are not files at a path on Windows')
		const { root, file } = outputFile('b1')
		const rec = recorder()
		const shells = createBackgroundShells({ emit: rec.emit, pollMs: 15 })
		try {
			execFileSync('mkfifo', [file])
			await shells.track({ toolUseId: 'bg1', sessionId: SESSION, resultText: template('b1', file), details: shellDetails('b1') })
			// A few polls against the pipe.
			await sleep(100)
			const started = Date.now()
			const notice = await shells.endTurn()
			// Well inside the backstop: the pipe is refused on open, not timed out on.
			expect(Date.now() - started).toBeLessThan(1_000)
			expect(notice).not.toBeNull()
			expect(rec.of('shell_output')).toHaveLength(0)
			expect(rec.of('shell_task_done')[0]?.payload).toMatchObject({ status: 'ended_with_turn', stdout: '' })
		} finally {
			await shells.stopAll()
			rmSync(root, { recursive: true, force: true })
		}
	})
})
