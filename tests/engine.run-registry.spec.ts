import { expect, test } from '@playwright/test'
import {
	getRunHandle,
	interruptRun,
	liveRunCount,
	registerRunHandle,
	type EngineQueryHandle,
} from '../src/lib/engine/run-registry.server'

/**
 * The process-local registry of live SDK sessions.
 *
 * Pure-function tests: `run-registry.server.ts` holds a `Map` and a logger and touches
 * neither the database nor SvelteKit, so this spec runs without Postgres or a dev server
 * (same arrangement as `automations.cron.spec.ts`).
 *
 * What is pinned here is mostly about *not* doing harm, because every caller is a stop
 * path and a stop path that throws is worse than one that reports it could not stop:
 *   - an unknown run is a quiet `false`, never an error, because "not in this process" is
 *     a normal answer (a worker-owned run, or one whose turn just ended)
 *   - a handle that throws on interrupt is still a `false`, not a thrown error
 *   - releasing is scoped to the handle that registered, so a re-run of the same id
 *     cannot have its live handle torn out by the previous attempt's teardown
 */

function fakeHandle(overrides: Partial<EngineQueryHandle> = {}): EngineQueryHandle {
	return {
		interrupt: async () => {},
		stopTask: async () => {},
		getContextUsage: async () => null,
		...overrides,
	}
}

/** Unique per test — the registry is module state shared across this file. */
let seq = 0
const nextId = () => `run-${++seq}`

test('a registered handle is reachable, and released again on demand', async () => {
	const runId = nextId()
	const handle = fakeHandle()

	const release = registerRunHandle(runId, handle)
	expect(getRunHandle(runId)).toBe(handle)

	release()
	expect(getRunHandle(runId)).toBeNull()
})

test('interrupting a live run calls through and reports success', async () => {
	const runId = nextId()
	let interrupted = 0
	const release = registerRunHandle(runId, fakeHandle({ interrupt: async () => void interrupted++ }))

	expect(await interruptRun(runId, 'test')).toBe(true)
	expect(interrupted).toBe(1)

	release()
})

test('an unknown run is a quiet false, not an error', async () => {
	// The dock can dismiss a run this process never held — a worker-owned one, or one that
	// finished a moment ago. That is an ordinary answer, so the caller gets `false` and
	// falls back to the database update it was doing anyway.
	expect(await interruptRun('never-registered', 'test')).toBe(false)
})

test('a handle that throws still reports false rather than propagating', async () => {
	const runId = nextId()
	const release = registerRunHandle(
		runId,
		fakeHandle({
			interrupt: async () => {
				// What the SDK actually throws when the turn ended and stdin is closed.
				throw new Error('Cannot write to terminated process')
			},
		}),
	)

	expect(await interruptRun(runId, 'test')).toBe(false)

	release()
})

test('release only removes the handle it registered', async () => {
	const runId = nextId()
	const first = fakeHandle()
	const second = fakeHandle()

	const releaseFirst = registerRunHandle(runId, first)
	// A retry under the same run id replaces the entry.
	const releaseSecond = registerRunHandle(runId, second)
	expect(getRunHandle(runId)).toBe(second)

	// The first attempt's teardown must not take the live one with it.
	releaseFirst()
	expect(getRunHandle(runId)).toBe(second)

	releaseSecond()
	expect(getRunHandle(runId)).toBeNull()
})

test('releasing twice is harmless', async () => {
	const runId = nextId()
	const release = registerRunHandle(runId, fakeHandle())
	release()
	release()
	expect(getRunHandle(runId)).toBeNull()
})

test('the live count tracks registration, and unwinds to where it started', async () => {
	const before = liveRunCount()
	const releases = [nextId(), nextId(), nextId()].map((id) => registerRunHandle(id, fakeHandle()))

	expect(liveRunCount()).toBe(before + 3)
	for (const release of releases) release()
	expect(liveRunCount()).toBe(before)
})
