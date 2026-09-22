/**
 * Process-local registry of live engine runs, keyed by `chat_runs.id`.
 *
 * The Agent SDK's `query()` returns a `Query` — an async iterable that is *also* a control
 * channel: `interrupt()`, `stopTask()`, `getContextUsage()` and the rest are control
 * requests written to the CLI's stdin while the turn is in flight. The engine used to cast
 * that object straight to an `AsyncIterable` and drop everything else, which is why nothing
 * outside the `for await` loop could ever affect a running turn.
 *
 * A registry is what makes the handle reachable from a *different* request than the one
 * that started the run. That is the whole point: "stop" arrives as a separate HTTP call (or
 * as a dropped connection), not as a return value from the loop that is still running.
 *
 * ## What this deliberately is not
 *
 * It is not durable, and it is not a source of truth. It is a `Map` in one process:
 *
 * - A run started by a different process (the jobs worker) is invisible here, so
 *   `interruptRun` returns false and the caller falls back to what it did before — marking
 *   the row canceled and letting the reaper catch the rest.
 * - A restart empties it. The `chat_runs` row survives; the handle does not.
 *
 * So every caller treats a `false` as "not stoppable from here", never as "no such run".
 * The database stays authoritative for run *state*; this only ever carries the live handle.
 *
 * Deployment note: chat runs execute in the web process, which is a single container here,
 * so in practice the stop button and the run share one. If that ever stops being true, this
 * needs to become a control message over a shared channel rather than a Map — the interface
 * below is deliberately small enough to keep in that case.
 */

// Relative rather than `$lib/...` so the registry can be imported directly by a spec in
// the plain Playwright loader, where the SvelteKit alias is not guaranteed to resolve.
import { logger } from '../observability/logger'

/**
 * The slice of the SDK's `Query` a caller outside the engine is allowed to touch.
 *
 * Narrow on purpose: handing out the raw `Query` would also hand out `next()`, and a second
 * consumer pulling messages off the same iterator would steal frames from the run loop.
 */
export type EngineQueryHandle = {
	/**
	 * Ask the CLI to stop the current turn. The run loop then sees a normal `result`
	 * message, so the turn is persisted as the partial it is rather than vanishing.
	 */
	interrupt(): Promise<void>
	/** Stop one background task by id (the `backgroundTaskId` on a backgrounded `Bash`). */
	stopTask(taskId: string): Promise<void>
	/** The CLI's own context accounting for this session, or null if it could not be read. */
	getContextUsage(): Promise<unknown | null>
}

const liveRuns = new Map<string, EngineQueryHandle>()

/** Publish a run's handle. Returns a release function; call it in a `finally`. */
export function registerRunHandle(runId: string, handle: EngineQueryHandle): () => void {
	liveRuns.set(runId, handle)
	return () => {
		// Only delete our own entry. A retried run that reuses the id would otherwise have
		// its live handle removed by the previous attempt's teardown.
		if (liveRuns.get(runId) === handle) liveRuns.delete(runId)
	}
}

export function getRunHandle(runId: string): EngineQueryHandle | null {
	return liveRuns.get(runId) ?? null
}

/** Live runs in this process. Diagnostics only — never a count of what is running overall. */
export function liveRunCount(): number {
	return liveRuns.size
}

/**
 * Interrupt a run if this process is the one running it.
 *
 * `false` means "not reachable from here", which is not the same as "not running" — see the
 * module note. Never throws: a stop path that fails because stopping failed is worse than
 * one that reports it could not.
 */
export async function interruptRun(runId: string, reason: string): Promise<boolean> {
	const handle = liveRuns.get(runId)
	if (!handle) return false

	try {
		await handle.interrupt()
		logger.info('[engine] interrupted run', { runId, reason })
		return true
	} catch (error) {
		// The commonest cause is benign: the turn finished between the lookup and the write,
		// and the CLI has already closed its stdin.
		logger.warn('[engine] interrupt failed', { runId, reason, error: String(error) })
		return false
	}
}
