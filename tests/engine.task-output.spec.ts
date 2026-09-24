import { execFileSync } from 'node:child_process'
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import {
	isTaskOutputPath,
	tailTaskOutput,
	taskOutputPathFromResult,
	type TaskOutputChunk,
} from '../src/lib/engine/task-output.server'

/**
 * #35 — a background command's output file: finding it in the CLI's text, and tailing it.
 *
 * The path is CLI-authored text on a host path outside the sandbox, so the part worth pinning
 * is what is refused: anything that is not exactly this session's, this task's output file.
 * The tail is exercised on real files — the whole point of it is how it meets a file that
 * grows, is not there yet, is cut short, or is not what it claims to be.
 */

const SESSION = '0f6d3c1e-5a4b-4c2d-9e8f-123456789abc'
const TASK = 'b7k2m9'
const anchor = { sessionId: SESSION, taskId: TASK }

const ROOT = process.platform === 'win32' ? 'C:\\Users\\A User\\AppData\\Local\\Temp\\claude\\proj' : '/tmp/claude/-work-proj'
const good = [ROOT, SESSION, 'tasks', `${TASK}.output`].join(sep)

/** The CLI's template for a backgrounded Bash result, as seen in CLI 2.1.278. */
const template = (path: string) =>
	`Command running in background with ID: ${TASK}. Output is being written to: ${path}. You will be notified when it completes. To check interim output, use Read on that file path.`

test.describe('which path is this task\'s output file', () => {
	test('the CLI\'s own path is accepted, spaces and all', () => {
		expect(isTaskOutputPath(good, anchor)).toBe(true)
		expect(taskOutputPathFromResult(template(good), anchor)).toBe(good)
	})

	test('anything not shaped like this session\'s, this task\'s file is refused', () => {
		const refused = {
			'no session segment': [ROOT, 'tasks', `${TASK}.output`].join(sep),
			'another session': [ROOT, 'another-session', 'tasks', `${TASK}.output`].join(sep),
			'another task': [ROOT, SESSION, 'tasks', 'zz9.output'].join(sep),
			'not under tasks/': [ROOT, SESSION, 'other', `${TASK}.output`].join(sep),
			relative: ['tmp', SESSION, 'tasks', `${TASK}.output`].join(sep),
			'a .. on the way': [ROOT, '..', 'x', SESSION, 'tasks', `${TASK}.output`].join(sep),
		}
		for (const [label, path] of Object.entries(refused)) {
			expect(isTaskOutputPath(path, anchor), label).toBe(false)
			expect(taskOutputPathFromResult(template(path), anchor), label).toBeNull()
		}
		// Ids that are not ids cannot anchor anything.
		expect(isTaskOutputPath(good, { sessionId: '..', taskId: TASK })).toBe(false)
		expect(isTaskOutputPath(good, { sessionId: SESSION, taskId: `a${sep}b` })).toBe(false)
	})

	test('two different paths in one result mean neither is read', () => {
		// A timed-out command's result carries its own output, which could imitate the template.
		const decoy = [process.platform === 'win32' ? 'C:\\evil' : '/evil', SESSION, 'tasks', `${TASK}.output`].join(sep)
		expect(taskOutputPathFromResult(`${template(good)}\n${template(decoy)}`, anchor)).toBeNull()
		// The same path twice is still one path.
		expect(taskOutputPathFromResult(`${template(good)}\n${template(good)}`, anchor)).toBe(good)
	})

	test('a result with no template names nothing', () => {
		expect(taskOutputPathFromResult('Command completed.', anchor)).toBeNull()
		expect(taskOutputPathFromResult(`Output is being written to: ${ROOT}`, anchor)).toBeNull()
	})
})

/** A real `<root>/<session>/tasks/` directory in the OS temp dir. */
function tasksDir() {
	const root = mkdtempSync(join(tmpdir(), 'as-task-output-'))
	const dir = join(root, SESSION, 'tasks')
	mkdirSync(dir, { recursive: true })
	return { root, dir, file: join(dir, `${TASK}.output`) }
}

/** Collect chunks, and wait for the text so far to satisfy a predicate. */
function collector() {
	const chunks: Array<{ text: string } & TaskOutputChunk> = []
	return {
		chunks,
		onChunk: (text: string, info: TaskOutputChunk) => {
			chunks.push({ text, ...info })
		},
		text: () => chunks.map((c) => c.text).join(''),
	}
}

test.describe('tailing the output file', () => {
	test('waits for the file, then delivers what is appended, in order', async () => {
		const { root, file } = tasksDir()
		const seen = collector()
		const tail = tailTaskOutput({ path: file, anchor, intervalMs: 15, onChunk: seen.onChunk })
		try {
			// Not there yet: nothing, and no giving up.
			await new Promise((r) => setTimeout(r, 60))
			expect(seen.chunks).toEqual([])

			writeFileSync(file, 'one\n')
			await expect.poll(seen.text).toBe('one\n')
			appendFileSync(file, 'two\n')
			await expect.poll(seen.text).toBe('one\ntwo\n')
			appendFileSync(file, 'three\n')
			await expect.poll(seen.text).toBe('one\ntwo\nthree\n')

			// Only the first chunk starts the card over.
			expect(seen.chunks.map((c) => c.reset)).toEqual([true, false, false])
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a character split across two reads comes out whole', async () => {
		const { root, file } = tasksDir()
		const seen = collector()
		const euro = Buffer.from('€', 'utf8') // three bytes
		writeFileSync(file, Buffer.concat([Buffer.from('cost: '), euro.subarray(0, 1)]))
		const tail = tailTaskOutput({ path: file, anchor, intervalMs: 15, onChunk: seen.onChunk })
		try {
			await expect.poll(seen.text).toBe('cost: ')
			appendFileSync(file, Buffer.concat([euro.subarray(1), Buffer.from('5\n')]))
			await expect.poll(seen.text).toBe('cost: €5\n')
			expect(seen.text()).not.toContain('\uFFFD')
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a file cut short starts over from the top', async () => {
		const { root, file } = tasksDir()
		const seen = collector()
		writeFileSync(file, 'a long first line\n')
		const tail = tailTaskOutput({ path: file, anchor, intervalMs: 15, onChunk: seen.onChunk })
		try {
			await expect.poll(seen.text).toBe('a long first line\n')
			writeFileSync(file, 'new\n')
			await expect.poll(() => seen.chunks.at(-1)?.text).toBe('new\n')
			expect(seen.chunks.at(-1)?.reset).toBe(true)
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a command that writes faster than a read skips to its newest output', async () => {
		const { root, file } = tasksDir()
		const seen = collector()
		writeFileSync(file, `${'x'.repeat(500)}TAIL`)
		const tail = tailTaskOutput({ path: file, anchor, intervalMs: 15, maxReadBytes: 64, onChunk: seen.onChunk })
		try {
			await expect.poll(() => seen.chunks.length).toBe(1)
			expect(seen.chunks[0].text.endsWith('TAIL')).toBe(true)
			expect(seen.chunks[0].text.length).toBe(64)
			expect(seen.chunks[0]).toMatchObject({ reset: true, skipped: true })
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('stop() ends the reads; finish() makes one last one first', async () => {
		const { root, file } = tasksDir()
		writeFileSync(file, '')
		const stopped = collector()
		const stopTail = tailTaskOutput({ path: file, anchor, intervalMs: 15, onChunk: stopped.onChunk })
		await stopTail.stop()
		appendFileSync(file, 'after stop\n')
		await new Promise((r) => setTimeout(r, 80))
		expect(stopped.chunks).toEqual([])

		// A long interval: only the final read can see this.
		const finished = collector()
		const finishTail = tailTaskOutput({ path: file, anchor, intervalMs: 60_000, onChunk: finished.onChunk })
		await finishTail.finish()
		expect(finished.text()).toBe('after stop\n')
		rmSync(root, { recursive: true, force: true })
	})

	test('onPoll follows every scheduled read, after its chunk, whether or not there was one', async () => {
		const { root, file } = tasksDir()
		writeFileSync(file, 'one\n')
		const events: string[] = []
		const tail = tailTaskOutput({
			path: file,
			anchor,
			intervalMs: 15,
			onChunk: (text) => {
				events.push(`chunk:${text}`)
			},
			onPoll: () => {
				events.push('poll')
			},
		})
		try {
			await expect.poll(() => events.filter((e) => e === 'poll').length).toBeGreaterThanOrEqual(3)
			expect(events.slice(0, 3)).toEqual(['chunk:one\n', 'poll', 'poll'])
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('the final read is not followed by onPoll', async () => {
		const { root, file } = tasksDir()
		writeFileSync(file, 'last\n')
		const events: string[] = []
		// A long interval: only the final read runs.
		const tail = tailTaskOutput({
			path: file,
			anchor,
			intervalMs: 60_000,
			onChunk: (text) => {
				events.push(`chunk:${text}`)
			},
			onPoll: () => {
				events.push('poll')
			},
		})
		await tail.finish()
		expect(events).toEqual(['chunk:last\n'])
		rmSync(root, { recursive: true, force: true })
	})

	test('a named pipe in place of the file is given up on at once, not waited on', async () => {
		// Without O_NONBLOCK, opening a FIFO waits for a writer that never comes: the read never
		// returns, and neither does `finish()` — nor the end of the turn that awaits it.
		test.skip(process.platform === 'win32', 'named pipes are not files at a path on Windows')
		const { root, file } = tasksDir()
		execFileSync('mkfifo', [file])
		const seen = collector()
		const reasons: string[] = []
		const tail = tailTaskOutput({
			path: file,
			anchor,
			intervalMs: 15,
			onChunk: seen.onChunk,
			onGiveUp: (reason) => reasons.push(reason),
		})
		try {
			await expect.poll(() => reasons, { timeout: 5_000 }).toEqual(['the output file is not a plain file'])
			const started = Date.now()
			await tail.finish()
			expect(Date.now() - started).toBeLessThan(1_000)
			expect(seen.chunks).toEqual([])
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a hard link to some other file is not read', async () => {
		const { root, file } = tasksDir()
		const secret = join(root, 'secret.txt')
		writeFileSync(secret, 'do not stream me\n')
		linkSync(secret, file)
		const seen = collector()
		const reasons: string[] = []
		const tail = tailTaskOutput({
			path: file,
			anchor,
			intervalMs: 15,
			onChunk: seen.onChunk,
			onGiveUp: (reason) => reasons.push(reason),
		})
		try {
			await expect.poll(() => reasons.length).toBe(1)
			expect(seen.chunks).toEqual([])
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('a symlink out of the tasks directory is not followed', async () => {
		const { root, file } = tasksDir()
		const secret = join(root, 'secret.txt')
		writeFileSync(secret, 'do not stream me\n')
		try {
			symlinkSync(secret, file)
		} catch {
			// Creating a symlink needs a privilege Windows does not grant by default.
			rmSync(root, { recursive: true, force: true })
			test.skip(true, 'symlinks cannot be created here')
			return
		}
		const seen = collector()
		const reasons: string[] = []
		const tail = tailTaskOutput({
			path: file,
			anchor,
			intervalMs: 15,
			onChunk: seen.onChunk,
			onGiveUp: (reason) => reasons.push(reason),
		})
		try {
			await expect.poll(() => reasons.length).toBe(1)
			expect(seen.chunks).toEqual([])
		} finally {
			await tail.stop()
			rmSync(root, { recursive: true, force: true })
		}
	})
})
