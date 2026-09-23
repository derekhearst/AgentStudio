import type { Scheduler } from '$lib/jobs/scheduler.server'
import type { Worker } from '$lib/jobs/worker.server'

/**
 * Per-process state that has to outlive an evaluation of `db.server.ts`.
 *
 * In production that module is evaluated once. Under `vite dev` it is not: editing any module
 * in its import graph — any `*.schema.ts`, or any job handler, since the bootstrap imports
 * them all — invalidates it, and the next request evaluates it again. Each evaluation used to
 * open a new postgres.js pool without closing the last (postgres.js keeps idle connections
 * open indefinitely by default), and start another job worker and scheduler without stopping
 * the previous ones. Ten edits into a session there were eleven pools and eleven worker loops
 * polling `jobs`, the old ones still running the old handler code — so a fix to a handler
 * appeared not to take effect, and the pools crept toward `max_connections`.
 *
 * So the pool lives here, on `globalThis`, and every evaluation reuses it. And each
 * evaluation's bootstrap is a numbered generation: starting one stops whatever the previous
 * generation started, and a generation may only start its worker and scheduler while it is
 * still the newest — a slow bootstrap overtaken by a later edit starts nothing.
 *
 * The state is plain data on `globalThis`, so it survives even if this module is itself
 * re-evaluated. Every function takes the state as an optional last argument so a spec can
 * exercise the rules on a private copy instead of the process's real worker.
 */

export type ProcessState = {
	client: unknown
	generation: number
	worker: Worker | null
	scheduler: Scheduler | null
}

const STATE_KEY = Symbol.for('agentstudio.db.processState')

export function createProcessState(): ProcessState {
	return { client: null, generation: 0, worker: null, scheduler: null }
}

function processState(): ProcessState {
	const holder = globalThis as typeof globalThis & { [STATE_KEY]?: ProcessState }
	return (holder[STATE_KEY] ??= createProcessState())
}

/** The process's database pool: created by the first evaluation, reused by every later one. */
export function reuseDatabaseClient<T>(create: () => T, state = processState()): T {
	state.client ??= create()
	return state.client as T
}

/**
 * Open a new bootstrap generation and stop the worker and scheduler the previous one
 * started. The previous worker finishes the job it is running, if any, then its loop exits.
 */
export function beginBootstrapGeneration(state = processState()): number {
	state.generation += 1
	const { worker, scheduler } = state
	state.worker = null
	state.scheduler = null
	if (worker || scheduler) {
		scheduler?.stop()
		void worker?.stop()
		console.log('[db] Module re-evaluated — stopped the previous job worker and scheduler')
	}
	return state.generation
}

export function isCurrentBootstrapGeneration(generation: number, state = processState()): boolean {
	return state.generation === generation
}

/**
 * Record what a bootstrap generation started. A generation that has been overtaken does not
 * get to keep anything: what it started is stopped on the spot, and false is returned.
 */
export function adoptBackgroundJobs(
	generation: number,
	started: { worker?: Worker; scheduler?: Scheduler },
	state = processState(),
): boolean {
	if (state.generation !== generation) {
		started.scheduler?.stop()
		void started.worker?.stop()
		return false
	}
	if (started.worker) state.worker = started.worker
	if (started.scheduler) state.scheduler = started.scheduler
	return true
}

/** The job worker and scheduler this process is running, for a shutdown that drains them. */
export function backgroundJobs(state = processState()): { worker: Worker | null; scheduler: Scheduler | null } {
	return { worker: state.worker, scheduler: state.scheduler }
}
