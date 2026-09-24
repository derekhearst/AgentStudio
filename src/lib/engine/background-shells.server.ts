/**
 * Backgrounded `Bash` commands, followed from the moment they start to the end of the turn (#35).
 *
 * The model can run a command with `run_in_background`; the call returns at once with a
 * task id, and the command keeps going. This keeps that command's card honest while it does:
 *
 * - **Live output.** The command's output file is tailed on the host (`./task-output.server`)
 *   and each new piece goes out as a `shell_output` frame against the call's id. The same
 *   text grows the call's persisted block, capped to its tail like any other shell output.
 * - **How it ended.** `task_notification` settles it — completed, failed or stopped, with the
 *   exit code when the CLI's summary gives one — as a `shell_task_done` frame. That frame is
 *   persisted and carries the final output, so a client that reconnected mid-turn (and missed
 *   the live-only `shell_output` frames) still ends up with what the command printed.
 * - **The turn ending first.** Background commands are turn-scoped here: the engine closes
 *   the CLI after every turn, and the commands it started end with it. A command still running
 *   when the reply is done is marked `ended_with_turn`, and the turn gets one notice saying so,
 *   rather than a card that says "running" forever.
 *
 * `background_tasks_changed` is deliberately not used to settle anything. The SDK calls it a
 * level signal with ids only, and says not to correlate it with the `task_started` /
 * `task_notification` edges — so the header chips follow it, and this follows the edges.
 *
 * A subagent's background commands are not followed: they are owned by the subagent and end
 * with its final response, and their calls live in the subagent's card, not the parent's.
 *
 * Never throws into the run loop. A command whose output file cannot be found or trusted
 * simply has no live output; its card still settles.
 */

import { appendStreamTail, MAX_STREAM_CHARS, type BackgroundShellStatus, type ShellDetails } from './tool-result-details'
import type { RunNotice, TaskSettled } from './sdk-notices'
import { isTaskOutputPath, tailTaskOutput, taskOutputPathFromResult, type TaskOutputTail } from './task-output.server'
import { logger } from '../observability/logger'

type Emit = (event: string, payload: unknown) => Promise<void>

/** `shell_output` — a piece of a background command's output, live-only. */
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
	/** Characters of output streamed before this chunk, since the last reset — lets a client see a gap. */
	from: number
	/** …and after it. */
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
}

export type BackgroundShells = {
	/**
	 * Start following a parent `Bash` call that was backgrounded. Marks `details` as running
	 * before the call's `tool_result` frame goes out, so the card opens in its live state.
	 */
	track(call: { toolUseId: string; sessionId: string | null; resultText: string; details: ShellDetails }): void
	/** A `task_notification` arrived. No-op for a task this is not following. */
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

export function createBackgroundShells(input: {
	emit: Emit
	/** Only a spec changes this. */
	pollMs?: number
}): BackgroundShells {
	const shells = new Map<string, TrackedShell>()

	const applyChunk = async (entry: TrackedShell, chunk: string, reset: boolean, skipped: boolean) => {
		const from = reset ? 0 : entry.streamed
		const next = reset ? appendStreamTail('', chunk) : appendStreamTail(entry.details.stdout, chunk)
		entry.details.stdout = next.text
		entry.details.truncated = next.truncated || skipped || (!reset && entry.details.truncated)
		entry.streamed = from + chunk.length
		const frame: ShellOutputFrame = {
			id: entry.toolUseId,
			taskId: entry.taskId,
			chunk: chunk.length > MAX_STREAM_CHARS ? chunk.slice(-MAX_STREAM_CHARS) : chunk,
			reset,
			truncated: entry.details.truncated,
			from,
			to: entry.streamed,
		}
		await input.emit('shell_output', frame)
	}

	const startTail = (entry: TrackedShell, path: string): TaskOutputTail | null => {
		if (!entry.sessionId) return null
		return tailTaskOutput({
			path,
			anchor: { sessionId: entry.sessionId, taskId: entry.taskId },
			intervalMs: input.pollMs,
			onChunk: (chunk, info) => applyChunk(entry, chunk, info.reset, info.skipped),
			onGiveUp: (reason) =>
				logger.warn('[engine] no live output for a background command', { taskId: entry.taskId, reason }),
		})
	}

	const close = async (entry: TrackedShell, status: ShellTaskDoneFrame['status'], exitCode: number | null) => {
		entry.settled = true
		entry.details.background = { status }
		if (exitCode !== null) entry.details.exitCode = exitCode
		const frame: ShellTaskDoneFrame = {
			id: entry.toolUseId,
			taskId: entry.taskId,
			status,
			exitCode,
			stdout: entry.details.stdout,
			truncated: entry.details.truncated,
		}
		await input.emit('shell_task_done', frame)
	}

	return {
		track({ toolUseId, sessionId, resultText, details }) {
			const taskId = details.backgroundTaskId
			if (!taskId || shells.has(taskId)) return
			details.background = { status: 'running' }
			const entry: TrackedShell = {
				toolUseId,
				taskId,
				sessionId,
				details,
				tail: null,
				streamed: 0,
				settled: false,
			}
			shells.set(taskId, entry)
			const path = sessionId ? taskOutputPathFromResult(resultText, { sessionId, taskId }) : null
			if (path) entry.tail = startTail(entry, path)
			else logger.info('[engine] background command has no readable output path', { taskId })
		},

		async settle(task) {
			const entry =
				shells.get(task.taskId) ??
				(task.toolUseId ? [...shells.values()].find((e) => e.toolUseId === task.toolUseId) : undefined)
			if (!entry || entry.settled) return
			// The result named no usable path; the notification's own gets one final read.
			if (
				!entry.tail &&
				task.outputFile &&
				entry.sessionId &&
				isTaskOutputPath(task.outputFile, { sessionId: entry.sessionId, taskId: entry.taskId })
			) {
				entry.tail = startTail(entry, task.outputFile)
			}
			await entry.tail?.finish()
			await close(entry, task.status, task.exitCode)
		},

		async endTurn() {
			const running = [...shells.values()].filter((entry) => !entry.settled)
			if (running.length === 0) return null
			for (const entry of running) {
				await entry.tail?.finish()
				await close(entry, 'ended_with_turn', null)
			}
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
			await Promise.all([...shells.values()].map((entry) => entry.tail?.stop()))
		},
	}
}
