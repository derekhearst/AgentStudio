/**
 * The writes a live chat run makes to its own `chat_runs` row while it runs and when it ends.
 *
 * Two problems, one module, because both are about the row staying true to the turn:
 *
 * 1. **A healthy run must look alive.** `reapStuckRuns` cancels any active run whose
 *    `updatedAt` is over an hour old, and interrupts it if this process holds it. The column
 *    has no `$onUpdate` and no trigger; the old runtime sessions bumped it on every heartbeat,
 *    and the engine path never did. So any turn that ran past an hour without an approval
 *    prompt — a long build, a large delegated task — was reaped mid-work.
 *    `createRunHeartbeat` is fed by the run's frames and touches the row at most every
 *    `RUN_HEARTBEAT_INTERVAL_MS`. Fed by frames rather than a timer on purpose: the SDK sends
 *    a `tool_progress` heartbeat for every call in flight, so a working run always has
 *    frames, and a session that goes silent for an hour is exactly what the reaper is for.
 *
 * 2. **A run that something else ended stays ended.** The reaper and the dock's dismiss both
 *    mark the row canceled and interrupt the session; the turn then winds down and reaches
 *    its own final write, which used to turn the canceled run back into "completed". Every
 *    write here is conditional on `finishedAt IS NULL`.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { logger } from '$lib/observability/logger'

/**
 * How often a live run touches its row. Two orders of magnitude inside the reaper's hour
 * (`STUCK_RUN_THRESHOLD_MS`), and rare enough to be noise next to the run's event writes.
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 30_000

export type RunHeartbeat = {
	/** Note that the run is doing something. Cheap: writes at most once per interval. */
	beat(): void
}

/** One heartbeat write. A run that has already ended is left as it is. */
export async function touchChatRun(runId: string, at: Date = new Date()): Promise<void> {
	await db
		.update(chatRuns)
		.set({ updatedAt: at, lastHeartbeatAt: at })
		.where(and(eq(chatRuns.id, runId), isNull(chatRuns.finishedAt)))
}

/**
 * A throttled heartbeat for one run. The row was written when the run was inserted, so the
 * first write comes one interval after creation, not on the first frame.
 *
 * `now` and `write` exist for the spec; the route passes neither.
 */
export function createRunHeartbeat(
	runId: string,
	options: {
		intervalMs?: number
		now?: () => number
		write?: (runId: string, at: Date) => Promise<void>
	} = {},
): RunHeartbeat {
	const intervalMs = options.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS
	const now = options.now ?? Date.now
	const write = options.write ?? touchChatRun
	let last = now()

	return {
		beat() {
			const at = now()
			if (at - last < intervalMs) return
			last = at
			// Never awaited by the caller: a missed heartbeat costs nothing until an hour of
			// them are missed, and a frame must never wait on one.
			void write(runId, new Date(at)).catch((error) =>
				logger.warn('[runs] heartbeat write failed', { runId, error: String(error) }),
			)
		},
	}
}

type TerminalPatch = {
	state: 'completed' | 'failed' | 'canceled'
	label: string
	error: string | null
	lastDelta?: string
}

/**
 * Record how a run ended, unless something else already ended it. Returns whether this write
 * was the one that did.
 */
export async function finishChatRun(runId: string, patch: TerminalPatch): Promise<boolean> {
	const now = new Date()
	const updated = await db
		.update(chatRuns)
		.set({ ...patch, lastHeartbeatAt: now, updatedAt: now, finishedAt: now })
		.where(and(eq(chatRuns.id, runId), isNull(chatRuns.finishedAt)))
		.returning({ id: chatRuns.id })
	return updated.length > 0
}

/**
 * Back to `running` after an approval or an answer — unless the run was ended while it
 * waited. A canceled row must not read as running again with its `finishedAt` still set.
 */
export async function markChatRunRunning(runId: string): Promise<void> {
	await db
		.update(chatRuns)
		.set({ state: 'running', label: 'Generating response', updatedAt: new Date() })
		.where(and(eq(chatRuns.id, runId), isNull(chatRuns.finishedAt)))
}
