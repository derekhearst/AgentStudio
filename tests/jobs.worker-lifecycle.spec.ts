import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * The job worker's life outside a single claim: how it is configured, how it stops, and how
 * a dev-mode re-evaluation of db.server.ts replaces it.
 *
 *   - scripts/worker.ts documented JOBS_WORKER_QUEUES/TYPES/POLL_MS/LEASE_MS/ID and nothing
 *     read them; the bootstrap hard-coded its options.
 *   - Its "drain" neither stopped claiming nor waited: it exited after a fixed 5s, killing any
 *     longer handler mid-run.
 *   - Every re-evaluation of db.server.ts under `vite dev` leaked a pool and started another
 *     worker and scheduler beside the old ones.
 *
 * Most of this is pure and runs without a database. The process-state rules are exercised on
 * a private state object, never the Playwright worker's real job worker.
 */

test.describe('jobs/worker-config — the JOBS_WORKER_* env vars', () => {
	test('unset means the defaults: every queue, every registered type, 2s poll, 120s lease', async () => {
		const { workerOptionsFromEnv } = await import('../src/lib/jobs/worker-config')
		expect(workerOptionsFromEnv({})).toEqual({
			queues: undefined,
			types: undefined,
			pollIntervalMs: 2_000,
			leaseTtlMs: 120_000,
			workerId: undefined,
		})
	})

	test('lists, numbers and the id are read', async () => {
		const { workerOptionsFromEnv } = await import('../src/lib/jobs/worker-config')
		expect(
			workerOptionsFromEnv({
				JOBS_WORKER_QUEUES: ' maintenance , default ,',
				JOBS_WORKER_TYPES: 'workspace_gc,metrics_sample',
				JOBS_WORKER_POLL_MS: '500',
				JOBS_WORKER_LEASE_MS: '30000',
				JOBS_WORKER_ID: ' maint-1 ',
			}),
		).toEqual({
			queues: ['maintenance', 'default'],
			types: ['workspace_gc', 'metrics_sample'],
			pollIntervalMs: 500,
			leaseTtlMs: 30_000,
			workerId: 'maint-1',
		})
	})

	test('a value that does not parse falls back, and a lease too short to heartbeat is raised', async () => {
		const { workerOptionsFromEnv, MIN_WORKER_LEASE_MS } = await import('../src/lib/jobs/worker-config')
		const options = workerOptionsFromEnv({
			JOBS_WORKER_QUEUES: ' , ',
			JOBS_WORKER_POLL_MS: 'soon',
			JOBS_WORKER_LEASE_MS: '1000',
			JOBS_WORKER_ID: '   ',
		})
		expect(options.queues).toBeUndefined()
		expect(options.pollIntervalMs).toBe(2_000)
		expect(options.leaseTtlMs).toBe(MIN_WORKER_LEASE_MS)
		expect(options.workerId).toBeUndefined()
	})

	test('the drain timeout', async () => {
		const { drainTimeoutFromEnv } = await import('../src/lib/jobs/worker-config')
		expect(drainTimeoutFromEnv({})).toBe(25_000)
		expect(drainTimeoutFromEnv({ JOBS_WORKER_DRAIN_MS: '60000' })).toBe(60_000)
		expect(drainTimeoutFromEnv({ JOBS_WORKER_DRAIN_MS: '-1' })).toBe(25_000)
	})
})

test.describe('jobs/in-flight — what a stopping worker waits for', () => {
	function gate() {
		let open!: () => void
		let fail!: (err: Error) => void
		const promise = new Promise<void>((resolve, reject) => {
			open = resolve
			fail = reject
		})
		return { promise, open, fail }
	}

	test('idle drains at once', async () => {
		const { createInFlightTracker } = await import('../src/lib/jobs/in-flight')
		expect(await createInFlightTracker().drain(1_000)).toBe(true)
	})

	test('waits for the work in flight to finish', async () => {
		const { createInFlightTracker } = await import('../src/lib/jobs/in-flight')
		const tracker = createInFlightTracker()
		const work = gate()
		void tracker.track(work.promise)

		let drained: boolean | null = null
		const draining = tracker.drain(5_000).then((result) => (drained = result))
		await new Promise((r) => setTimeout(r, 50))
		expect(drained, 'must not report drained while the handler is still running').toBeNull()

		work.open()
		expect(await draining).toBe(true)
	})

	test('gives up at the deadline, and does not wait at all without one', async () => {
		const { createInFlightTracker } = await import('../src/lib/jobs/in-flight')
		const tracker = createInFlightTracker()
		const work = gate()
		void tracker.track(work.promise)

		expect(await tracker.drain(0)).toBe(false)
		expect(await tracker.drain(50)).toBe(false)
		work.open()
		await work.promise
		expect(await tracker.drain(0)).toBe(true)
	})

	test('work that fails counts as finished', async () => {
		const { createInFlightTracker } = await import('../src/lib/jobs/in-flight')
		const tracker = createInFlightTracker()
		const work = gate()
		const tracked = tracker.track(work.promise).catch(() => undefined)
		const draining = tracker.drain(5_000)
		work.fail(new Error('handler blew up'))
		await tracked
		expect(await draining).toBe(true)
	})
})

test.describe('jobs/worker — the type filter', () => {
	test('a listed type with no registered handler is never claimed', async () => {
		// Before: JOBS_WORKER_TYPES replaced the registered-handler list outright, so a listed
		// type without a handler was claimed and then failed "no registered handler".
		const prefix = uniquePrefix('worker-types')
		const type = `${prefix}-unhandled`
		const sql = getSql()
		const { ensureDatabaseReady } = await import('../src/lib/db.server')
		await ensureDatabaseReady()
		const { startJobWorker } = await import('../src/lib/jobs/worker.server')
		const worker = startJobWorker({ types: [type], pollIntervalMs: 60_000 })
		try {
			const [job] = await sql<{ id: string }[]>`insert into jobs (type) values (${type}) returning id`
			expect(await worker.tickOnce()).toBe(false)
			const [row] = await sql<{ status: string; attempt_count: number }[]>`
				select status::text as status, attempt_count from jobs where id = ${job.id}
			`
			expect(row.status).toBe('pending')
		} finally {
			expect(await worker.stop()).toBe(true)
			await sql`delete from jobs where type like ${`${prefix}%`}`
		}
	})
})

test.describe('db/process-state — a dev-mode re-evaluation of db.server.ts', () => {
	function fakeWorker() {
		const calls = { stop: 0 }
		return {
			calls,
			worker: {
				workerId: 'fake',
				stop: async () => {
					calls.stop += 1
					return true
				},
				tickOnce: async () => false,
			},
		}
	}

	function fakeScheduler() {
		const calls = { stop: 0 }
		return {
			calls,
			scheduler: {
				stop: () => {
					calls.stop += 1
				},
				tickAll: async () => undefined,
			},
		}
	}

	test('reuses the one pool instead of opening another', async () => {
		const { createProcessState, reuseDatabaseClient } = await import('../src/lib/db/process-state.server')
		const state = createProcessState()
		let created = 0
		const make = () => ({ pool: ++created })
		const first = reuseDatabaseClient(make, state)
		const second = reuseDatabaseClient(make, state)
		expect(second).toBe(first)
		expect(created).toBe(1)
	})

	test('a new generation stops the worker and scheduler the previous one started', async () => {
		const { adoptBackgroundJobs, backgroundJobs, beginBootstrapGeneration, createProcessState } = await import(
			'../src/lib/db/process-state.server'
		)
		const state = createProcessState()
		const first = beginBootstrapGeneration(state)
		const w = fakeWorker()
		const s = fakeScheduler()
		expect(adoptBackgroundJobs(first, { worker: w.worker, scheduler: s.scheduler }, state)).toBe(true)
		expect(backgroundJobs(state).worker).toBe(w.worker)

		const second = beginBootstrapGeneration(state)
		expect(second).toBeGreaterThan(first)
		expect(w.calls.stop).toBe(1)
		expect(s.calls.stop).toBe(1)
		expect(backgroundJobs(state)).toEqual({ worker: null, scheduler: null })
	})

	test('an overtaken bootstrap starts nothing that survives', async () => {
		const { adoptBackgroundJobs, backgroundJobs, beginBootstrapGeneration, createProcessState, isCurrentBootstrapGeneration } =
			await import('../src/lib/db/process-state.server')
		const state = createProcessState()
		const slow = beginBootstrapGeneration(state)
		const fast = beginBootstrapGeneration(state)
		expect(isCurrentBootstrapGeneration(slow, state)).toBe(false)

		const late = fakeWorker()
		expect(adoptBackgroundJobs(slow, { worker: late.worker }, state)).toBe(false)
		expect(late.calls.stop, 'the stale generation’s worker is stopped on the spot').toBe(1)

		const current = fakeWorker()
		expect(adoptBackgroundJobs(fast, { worker: current.worker }, state)).toBe(true)
		expect(backgroundJobs(state).worker).toBe(current.worker)
	})
})
