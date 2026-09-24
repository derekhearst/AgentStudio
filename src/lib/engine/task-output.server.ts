/**
 * A background command's output file: finding it, and reading it while it grows (#35, #26).
 *
 * ## Why a file
 *
 * The SDK sends no output for a running command. `tool_progress` carries elapsed seconds and
 * nothing else, and the polling tool the plan once assumed is gone: in SDK 0.3.278
 * `BashOutput` is only the `Bash` tool's output *type* (`sdk-tools.d.ts`), and `sdk.d.ts` says
 * the `TaskOutput` tool was removed — "read a background task's output file … instead". What
 * the CLI does do is write a backgrounded command's output to a file as it runs, and tell the
 * model where, in a tool result it writes from a template:
 *
 *     Command running in background with ID: <taskId>. Output is being written to: <path>. …
 *
 * `task_notification` carries the same path as `output_file` when the task settles. The file
 * lives in the CLI's temp tree, `<tmp>/claude/<project>/<sessionId>/tasks/<taskId>.output`
 * (seen in CLI 2.1.278), which is on the host, beside the sandbox rather than inside it — so
 * the web process can read it directly and stream what arrives into the command's card.
 *
 * ## What is trusted
 *
 * Nothing the model or the command wrote. The path comes out of CLI-authored text, but a
 * timed-out command's result can carry its own stdout too, and a sandboxed command may be
 * able to write under the CLI's temp tree. So a path is only read when:
 *
 * - it is absolute, with no `..`, and ends `<sessionId>/tasks/<taskId>.output` — both ids the
 *   CLI's own, taken from the session and the typed `backgroundTaskId`, never from text;
 * - it is the only such path the result names (a second, different one means something is
 *   imitating the template, and neither is read);
 * - the file really is one: opened without following a final symlink and without waiting on
 *   a named pipe, a regular file with a single link, whose real path — every link resolved,
 *   through `$lib/workspace/containment` — still has that same shape.
 *
 * Every failure means "no live output", never an error: this runs beside the run loop, and a
 * card that stays quiet is always an acceptable answer. The CLI's layout is outside the typed
 * contract, so an SDK bump that moves the file lands here, as silence, not as a crash.
 */

import { constants as fsConstants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { resolveRealPath } from '$lib/workspace/containment.server'

/** The CLI's two ids a task output path must carry. */
export type TaskOutputAnchor = { sessionId: string; taskId: string }

/** What the CLI's template says just before the path. */
const OUTPUT_MARKER = 'Output is being written to: '

/** Ids the CLI mints: no separators, no dot-only names. Anything else is not an id. */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** How often a running command's file is read. The frames are live-only, so once a second is plenty. */
export const TASK_OUTPUT_POLL_MS = 1_000

/**
 * The most read in one go. A command that writes faster than this skips ahead to the newest
 * bytes — the card keeps only the tail anyway (`MAX_STREAM_CHARS`), and a reader that fell
 * behind would show output from minutes ago.
 */
export const TASK_OUTPUT_MAX_READ_BYTES = 64 * 1024

function hasParentSegment(path: string): boolean {
	return path.split(/[\\/]+/).includes('..')
}

/** True when `path` has the shape the CLI gives this task's output file. Lexical only. */
export function isTaskOutputPath(path: string, anchor: TaskOutputAnchor): boolean {
	if (!SAFE_ID.test(anchor.sessionId) || !SAFE_ID.test(anchor.taskId)) return false
	if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return false
	if (!isAbsolute(path) || hasParentSegment(path)) return false
	const tasksDir = dirname(path)
	return (
		basename(path) === `${anchor.taskId}.output` &&
		basename(tasksDir) === 'tasks' &&
		basename(dirname(tasksDir)) === anchor.sessionId
	)
}

/**
 * The output file a backgrounded `Bash` result names, or null.
 *
 * Paths can contain spaces (a Windows profile directory), so the path is not cut at
 * whitespace: it runs from the marker to the task's own file name on the same line. Every
 * occurrence is considered, and the answer is only given when they all agree.
 */
export function taskOutputPathFromResult(resultText: string, anchor: TaskOutputAnchor): string | null {
	if (typeof resultText !== 'string') return null
	const fileName = `${anchor.taskId}.output`
	const found = new Set<string>()
	let from = 0
	for (;;) {
		const at = resultText.indexOf(OUTPUT_MARKER, from)
		if (at < 0) break
		from = at + OUTPUT_MARKER.length
		const lineEnd = resultText.indexOf('\n', from)
		const line = resultText.slice(from, lineEnd < 0 ? undefined : lineEnd)
		for (let end = line.indexOf(fileName); end >= 0; end = line.indexOf(fileName, end + 1)) {
			const candidate = line.slice(0, end + fileName.length)
			if (isTaskOutputPath(candidate, anchor)) {
				found.add(candidate)
				break
			}
		}
	}
	return found.size === 1 ? [...found][0] : null
}

/** The real path, every link resolved, still has the task output shape. */
function staysATaskOutput(path: string, anchor: TaskOutputAnchor): boolean {
	try {
		return isTaskOutputPath(resolveRealPath(path), anchor)
	} catch {
		return false
	}
}

export type TaskOutputChunk = {
	/**
	 * True when this chunk is the start of what should be shown, not an addition to it: the
	 * first read of the file, a file that was truncated, or a skip ahead to its newest bytes.
	 */
	reset: boolean
	/** True when bytes before this chunk were never read (a skip ahead). */
	skipped: boolean
}

export type TaskOutputTail = {
	/** One last read of whatever has arrived, then stop. Resolves once that read is done. */
	finish(): Promise<void>
	/** Stop without reading. Idempotent; resolves once any read in flight is done. */
	stop(): Promise<void>
}

/**
 * How the file is opened, the way the bundled CLI opens its own task output files.
 *
 * - `O_NOFOLLOW`: a final symlink fails the open instead of being followed.
 * - `O_NONBLOCK`: a named pipe put where the file should be opens at once, and then fails the
 *   `isFile()` check below. Without it, `open()` on a FIFO waits for a writer that may never
 *   come — holding a libuv threadpool thread, and every read queued behind it, for good.
 *   Regular files ignore the flag.
 *
 * Neither exists on Windows, which has no such files at a path like this one.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)

/** A UTF-8 continuation byte: a read that starts on one is in the middle of a character. */
const isContinuationByte = (byte: number) => (byte & 0xc0) === 0x80

/**
 * Read `path` from where the last read stopped, every `intervalMs`, until told to stop.
 *
 * A file that does not exist yet is waited for. A file that stops looking like this task's
 * output (a symlink, a hard link, a named pipe, a real path somewhere else) is given up on for
 * good. Reads never overlap, and `onChunk` is awaited, so the caller sees chunks strictly in
 * order. Never throws; `onGiveUp` says why a tail went quiet.
 */
export function tailTaskOutput(input: {
	path: string
	anchor: TaskOutputAnchor
	onChunk: (chunk: string, info: TaskOutputChunk) => void | Promise<void>
	onGiveUp?: (reason: string) => void
	intervalMs?: number
	maxReadBytes?: number
}): TaskOutputTail {
	const intervalMs = Math.max(10, input.intervalMs ?? TASK_OUTPUT_POLL_MS)
	const maxReadBytes = Math.max(4, input.maxReadBytes ?? TASK_OUTPUT_MAX_READ_BYTES)

	let offset = 0
	let decoder = new TextDecoder('utf-8')
	/** The next chunk starts what should be shown (see `TaskOutputChunk.reset`). */
	let reset = true
	/** …and bytes before it were skipped rather than read. */
	let skipped = false
	let gaveUp = false
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | null = null
	let chain: Promise<void> = Promise.resolve()

	const giveUp = (reason: string) => {
		if (gaveUp) return
		gaveUp = true
		input.onGiveUp?.(reason)
	}

	const readOnce = async (final: boolean) => {
		if (gaveUp) return
		let handle: FileHandle
		try {
			handle = await open(input.path, OPEN_FLAGS)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code
			// Not written yet: the command has not produced anything. Try again next time.
			if (code === 'ENOENT') return
			giveUp(`cannot open the output file (${code ?? 'unknown error'})`)
			return
		}
		try {
			const stat = await handle.stat()
			// Checked on the open descriptor, so a swap after the open cannot change the answer.
			if (!stat.isFile() || stat.nlink > 1) return giveUp('the output file is not a plain file')
			if (!staysATaskOutput(input.path, input.anchor)) return giveUp('the output file resolves elsewhere')

			let skippedNow = false
			if (stat.size < offset) {
				// Truncated or replaced: start again from the top.
				offset = 0
				decoder = new TextDecoder('utf-8')
				reset = true
				skipped = false
			}
			if (stat.size - offset > maxReadBytes) {
				offset = stat.size - maxReadBytes
				decoder = new TextDecoder('utf-8')
				reset = true
				skipped = true
				skippedNow = true
			}

			let text = ''
			const length = stat.size - offset
			if (length > 0) {
				const buffer = Buffer.alloc(length)
				const { bytesRead } = await handle.read(buffer, 0, length, offset)
				offset += bytesRead
				let bytes = buffer.subarray(0, bytesRead)
				if (skippedNow) {
					// A skip lands wherever it lands; drop a partial character rather than print U+FFFD.
					let drop = 0
					while (drop < 3 && drop < bytes.length && isContinuationByte(bytes[drop])) drop++
					bytes = bytes.subarray(drop)
				}
				text = decoder.decode(bytes, { stream: !final })
			} else if (final) {
				text = decoder.decode()
			}
			if (text.length === 0) return

			const info: TaskOutputChunk = { reset, skipped: reset && skipped }
			reset = false
			skipped = false
			await input.onChunk(text, info)
		} finally {
			await handle.close().catch(() => {})
		}
	}

	const run = (final: boolean) => {
		chain = chain.then(() => readOnce(final)).catch(() => {})
		return chain
	}

	const schedule = () => {
		if (stopped) return
		timer = setTimeout(() => {
			timer = null
			void run(false).then(schedule)
		}, intervalMs)
		// A tail must never be what keeps the process alive.
		timer.unref?.()
	}

	const halt = () => {
		stopped = true
		if (timer) clearTimeout(timer)
		timer = null
	}

	schedule()

	return {
		async finish() {
			if (stopped) return chain
			halt()
			await run(true)
		},
		async stop() {
			halt()
			await chain
		},
	}
}
