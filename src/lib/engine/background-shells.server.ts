/**
 * Backgrounded `Bash` commands, followed from the moment they start to the end of the turn (#35).
 *
 * The model can run a command with `run_in_background`; the call returns at once with a
 * task id, and the command keeps going. This keeps that command's card honest while it does:
 *
 * - **Live output.** The command's output file is tailed on the host (`./task-output.server`)
 *   and each new piece goes out as a `shell_output` frame against the call's id. The same
 *   text grows the call's persisted block, capped to its tail like any other shell output.
 * - **Catching up.** `shell_output` is live-only (one a second would be a flood of rows), so a
 *   page that reloads or reconnects mid-turn — a phone tab brought back, a network blip — would
 *   never see another one. What arrived since the last save therefore also goes out as a
 *   persisted `shell_output_checkpoint`, at most every `SHELL_CHECKPOINT_MS` and only when
 *   there is something new. The resume replay delivers those, so a reattached card catches up
 *   and then keeps moving, a few seconds behind rather than frozen.
 * - **How it ended.** `task_notification` settles it — completed, failed or stopped, with the
 *   exit code when the CLI's summary gives one — as a `shell_task_done` frame. That frame is
 *   persisted and carries the final output, so every client ends up with exactly what was saved.
 * - **The turn ending first.** Background commands are turn-scoped here: the engine closes
 *   the CLI after every turn, and the commands it started end with it. A command still running
 *   when the reply is done is marked `ended_with_turn`, and the turn gets one notice saying so,
 *   rather than a card that says "running" forever.
 *
 * `background_tasks_changed` is deliberately not used to settle anything. The SDK calls it a
 * level signal with ids only, and says not to correlate it with the `task_started` /
 * `task_notification` edges — so the header chips follow it, and this follows the edges.
 *
 * A notification can also arrive before the call's own `tool_result`: the CLI emits it the
 * moment the task ends, and a command that exits at once (a typo, `ls`) can end before its
 * result is written out. Such a settlement is held until the call is tracked, and the card
 * is then created already settled instead of running until the turn ends.
 *
 * A subagent's background commands are not followed: they are owned by the subagent and end
 * with its final response, and their calls live in the subagent's card, not the parent's.
 *
 * Never throws into the run loop, and never holds it up for long: a final read that does not
 * come back within `TAIL_FINISH_TIMEOUT_MS` is abandoned. A command whose output file cannot be
 * found or trusted simply has no live output; its card still settles.
 */

import { appendStreamTail, MAX_STREAM_CHARS, type BackgroundShellStatus, type ShellDetails } from './tool-result-details'
import type { RunNotice, TaskSettled } from './sdk-notices'
import { isTaskOutputPath, tailTaskOutput, taskOutputPathFromResult, type TaskOutputTail } from './task-output.server'
import { logger } from '../observability/logger'

type Emit = (event: string, payload: unknown) => Promise<void>

/**
 * `shell_output` — a piece of a background command's output. Live-only.
 *
 * `shell_output_checkpoint` has the same shape and is persisted: everything since the
 * previous checkpoint, in one chunk. A client applies both the same way, and the positions
 * let it skip what it already has.
 */
export type ShellOutputFrame = {
	/** The `Bash` call's tool_use id — the id the chat keys the card on. */
	id: string
	taskId: string
	/** New output. At most `MAX_STREAM_CHARS`: anything before that would be cut from the tail anyway. */
	chunk: string
	/** Replace what the card shows with `chunk` instead of adding to it. */
	reset: boolean
	/** Whether the card's output is now only a tail. */
	truncated: boolean
	/**
	 * Where `chunk` starts, in characters of output since the last reset. Lets a client see a
	 * gap (it has less than this) or an overlap (it already has some of the chunk).
	 */
	from: number
	/** …and where it ends: `from + chunk.length`. */
	to: number
}

/** `shell_task_done` — a background command settled, or its turn ended. Persisted. */
export type ShellTaskDoneFrame = {
	id: string
	taskId: string
	status: Exclude<BackgroundShellStatus, 'running'>
	exitCode: number | null
	/** The command's output as the card should finally show it (already capped). */
	stdout: string
	truncated: boolean
}

/** The shortest time between two persisted checkpoints of one command's output. */
export const SHELL_CHECKPOINT_MS = 5_000

/**
 * The longest one final read may hold up the end of a turn. A read cannot normally take more
 * than milliseconds; this is the backstop for one that never returns, so the engine still
 * closes the CLI and still sends `done`.
 */
export const TAIL_FINISH_TIMEOUT_MS = 2_000

/** Settlements held for calls not tracked yet. Bounded: a subagent's tasks are never claimed. */
const MAX_EARLY_SETTLEMENTS = 64

type TrackedShell = {
	toolUseId: string
	taskId: string
	sessionId: string | null
	/** The object on the call's block — mutated in place, so the persisted block follows along. */
	details: ShellDetails
	tail: TaskOutputTail | null
	/** Characters streamed since the last reset. */
	streamed: number
	settled: boolean
	/**
	 * False for a command that had already settled when its result arrived. Its card is created
	 * final by the `tool_result` frame, so there is nothing to stream to and nothing to save.
	 */
	live: boolean
	/** Output since the last checkpoint: a reset in between makes the next checkpoint one too. */
	unsaved: { chunk: string; reset: boolean } | null
	/** When the last checkpoint went out; 0 until one has, so the first output is saved at once. */
	savedAt: number
}

export type BackgroundShells = {
	/**
	 * Start following a parent `Bash` call that was backgrounded. Marks `details` as running
	 * before the call's `tool_result` frame goes out, so the card opens in its live state —
	 * or, when the task already settled, reads its output once and marks it settled, so the
	 * card opens final. Await it before sending the `tool_result` frame.
	 */
	track(call: { toolUseId: string; sessionId: string | null; resultText: string; details: ShellDetails }): Promise<void>
	/** A `task_notification` arrived. Held for later when the call is not tracked yet. */
	settle(task: TaskSettled): Promise<void>
	/**
	 * The turn is over: read each still-running command's output one last time and mark it
	 * `ended_with_turn`. Returns the notice to add to the turn, or null when nothing was running.
	 */
	endTurn(): Promise<RunNotice | null>
	/** Stop every tail without reading. For the engine's `finally`; idempotent. */
	stopAll(): Promise<void>
}

/** Longest list of commands the end-of-turn notice names. */
const MAX_NOTICE_DETAIL = 300

const keepTail = (text: string) => (text.length > MAX_STREAM_CHARS ? text.slice(-MAX_STREAM_CHARS) : text)

/** Wait for `work`, but no longer than `ms`. True when it finished in time. Never rejects. */
async function within(work: Promise<unknown> | undefined, ms: number): Promise<boolean> {
	if (!work) return true
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms)
	})
	try {
		return await Promise.race([work.then(() => true, () => true), timedOut])
	} finally {
		clearTimeout(timer)
	}
}

export function createBackgroundShells(input: {
	emit: Emit
	/** Only a spec changes these. */
	pollMs?: number
	checkpointMs?: number
	finishTimeoutMs?: number
	tail?: typeof tailTaskOutput
}): BackgroundShells {
	const shells = new Map<string, TrackedShell>()
	/** `task_notification`s that arrived before their call's result, by task id. */
	const early = new Map<string, TaskSettled>()
	const checkpointMs = Math.max(0, input.checkpointMs ?? SHELL_CHECKPOINT_MS)
	const finishTimeoutMs = Math.max(1, input.finishTimeoutMs ?? TAIL_FINISH_TIMEOUT_MS)
	const tail = input.tail ?? tailTaskOutput
	/** Set by `stopAll`: nothing may be emitted after the engine's `finally`. */
	let closed = false

	const frame = (entry: TrackedShell, chunk: string, reset: boolean): ShellOutputFrame => ({
		id: entry.toolUseId,
		taskId: entry.taskId,
		chunk,
		reset,
		truncated: entry.details.truncated,
		from: entry.streamed - chunk.length,
		to: entry.streamed,
	})

	const applyChunk = async (entry: TrackedShell, chunk: string, reset: boolean, skipped: boolean) => {
		// A read that came back after its command was closed (a final read that timed out).
		if (entry.settled || closed) return
		const next = reset ? appendStreamTail('', chunk) : appendStreamTail(entry.details.stdout, chunk)
		entry.details.stdout = next.text
		entry.details.truncated = next.truncated || skipped || (!reset && entry.details.truncated)
		entry.streamed = (reset ? 0 : entry.streamed) + chunk.length
		if (!entry.live) return

		const kept = keepTail(chunk)
		entry.unsaved =
			reset || !entry.unsaved
				? { chunk: kept, reset }
				: { chunk: keepTail(entry.unsaved.chunk + kept), reset: entry.unsaved.reset }
		await input.emit('shell_output', frame(entry, kept, reset))
	}

	/** Persist what arrived since the last checkpoint, when there is some and one is due. */
	const checkpoint = async (entry: TrackedShell) => {
		if (!entry.live || entry.settled || closed || !entry.unsaved) return
		const now = Date.now()
		if (entry.savedAt !== 0 && now - entry.savedAt < checkpointMs) return
		const { chunk, reset } = entry.unsaved
		entry.unsaved = null
		entry.savedAt = now
		await input.emit('shell_output_checkpoint', frame(entry, chunk, reset))
	}

	const startTail = (entry: TrackedShell, path: string): TaskOutputTail | null => {
		if (!entry.sessionId) return null
		return tail({
			path,
			anchor: { sessionId: entry.sessionId, taskId: entry.taskId },
			intervalMs: input.pollMs,
			onChunk: (chunk, info) => applyChunk(entry, chunk, info.reset, info.skipped),
			onPoll: () => checkpoint(entry),
			onGiveUp: (reason) =>
				logger.warn('[engine] no live output for a background command', { taskId: entry.taskId, reason }),
		})
	}

	/** One last read, bounded: a read that never returns must not hold up the end of the turn. */
	const finishTail = async (entry: TrackedShell) => {
		if (await within(entry.tail?.finish(), finishTimeoutMs)) return
		logger.warn('[engine] gave up on the final read of a background command', {
			taskId: entry.taskId,
			timeoutMs: finishTimeoutMs,
		})
	}

	const close = async (entry: TrackedShell, status: ShellTaskDoneFrame['status'], exitCode: number | null) => {
		entry.settled = true
		entry.details.background = { status }
		if (exitCode !== null) entry.details.exitCode = exitCode
		const done: ShellTaskDoneFrame = {
			id: entry.toolUseId,
			taskId: entry.taskId,
			status,
			exitCode,
			stdout: entry.details.stdout,
			truncated: entry.details.truncated,
		}
		await input.emit('shell_task_done', done)
	}

	const findTracked = (task: TaskSettled) =>
		shells.get(task.taskId) ??
		(task.toolUseId ? [...shells.values()].find((e) => e.toolUseId === task.toolUseId) : undefined)

	const takeEarly = (taskId: string, toolUseId: string): TaskSettled | null => {
		const found = early.get(taskId) ?? [...early.values()].find((t) => t.toolUseId === toolUseId)
		if (!found) return null
		early.delete(found.taskId)
		return found
	}

	return {
		async track({ toolUseId, sessionId, resultText, details }) {
			const taskId = details.backgroundTaskId
			if (!taskId || shells.has(taskId)) return
			const settled = takeEarly(taskId, toolUseId)
			const entry: TrackedShell = {
				toolUseId,
				taskId,
				sessionId,
				details,
				tail: null,
				streamed: 0,
				settled: false,
				live: !settled,
				unsaved: null,
				savedAt: 0,
			}
			shells.set(taskId, entry)
			const anchor = sessionId ? { sessionId, taskId } : null
			const fromNotification =
				anchor && settled?.outputFile && isTaskOutputPath(settled.outputFile, anchor) ? settled.outputFile : null
			const path = (anchor ? taskOutputPathFromResult(resultText, anchor) : null) ?? fromNotification

			if (!settled) {
				details.background = { status: 'running' }
				if (path) entry.tail = startTail(entry, path)
				else logger.info('[engine] background command has no readable output path', { taskId })
				return
			}

			// It already ended: one read for its output, and the card is created settled. The
			// `tool_result` frame that follows carries all of it, so no frame goes out from here.
			if (path) {
				entry.tail = startTail(entry, path)
				await finishTail(entry)
			}
			entry.settled = true
			details.background = { status: settled.status }
			if (settled.exitCode !== null) details.exitCode = settled.exitCode
		},

		async settle(task) {
			const entry = findTracked(task)
			if (!entry) {
				// Its call's result has not arrived yet; `track` picks this up.
				if (early.size >= MAX_EARLY_SETTLEMENTS) early.delete(early.keys().next().value as string)
				early.set(task.taskId, task)
				return
			}
			if (entry.settled) return
			// The result named no usable path; the notification's own gets one final read.
			if (
				!entry.tail &&
				task.outputFile &&
				entry.sessionId &&
				isTaskOutputPath(task.outputFile, { sessionId: entry.sessionId, taskId: entry.taskId })
			) {
				entry.tail = startTail(entry, task.outputFile)
			}
			await finishTail(entry)
			await close(entry, task.status, task.exitCode)
		},

		async endTurn() {
			early.clear()
			const running = [...shells.values()].filter((entry) => !entry.settled)
			if (running.length === 0) return null
			await Promise.all(running.map(finishTail))
			for (const entry of running) await close(entry, 'ended_with_turn', null)
			const names = running.map((entry) => entry.details.command ?? entry.details.description ?? entry.taskId)
			const list = names.join(', ')
			return {
				kind: 'task_finished',
				level: 'warn',
				title:
					running.length === 1
						? 'A background command was stopped when the turn ended'
						: `${running.length} background commands were stopped when the turn ended`,
				detail: list.length > MAX_NOTICE_DETAIL ? `${list.slice(0, MAX_NOTICE_DETAIL)}…` : list,
				persist: true,
			}
		},

		async stopAll() {
			closed = true
			const stopping = Promise.all([...shells.values()].map((entry) => entry.tail?.stop()))
			if (!(await within(stopping, finishTimeoutMs))) {
				logger.warn('[engine] a background command read was still running when the turn closed', {
					timeoutMs: finishTimeoutMs,
				})
			}
		},
	}
}
