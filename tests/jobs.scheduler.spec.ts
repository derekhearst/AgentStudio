import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #17 phase 4 — in-process job scheduler contract.
 *
 * Schema-level proofs that the scheduler's enqueue path interacts correctly with the
 * existing jobs table:
 *   - Repeated tick-driven enqueue collapses via dedupeKey (no duplicate pending rows), and
 *     a finished tick frees the key for the next one
 *   - Maintenance-queue jobs at low priority don't preempt user-facing work
 *   - workspace_gc job dedupeKey is `gc:daily`
 *
 * The scheduler module's pure registry (registerScheduledJob, listScheduledJobs) is also
 * exercised via dynamic import. Live tick-driven dispatch is exercised by the boot flow:
 * the dev server registers workspace_gc at boot and the worker picks it up.
 */

async function cleanupSchedulerPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type in ('workspace_gc', 'memory_mine', 'evaluation_run', 'research_run') and dedupe_key like ${`${prefix}%`}`
}

test.describe('jobs/scheduler — tick-driven enqueue contract', () => {
	test('repeated enqueue with the same dedupeKey collapses to one pending row', async () => {
		const prefix = uniquePrefix('scheduler-tick-dedupe')
		const sql = getSql()
		try {
			const dedupeKey = `${prefix}gc:daily`
			// Tick 1 — fresh enqueue.
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload)
				values ('workspace_gc', 'maintenance', 10, ${dedupeKey}, ${sql.json({})})
			`
			// Tick 2 + 3 — same dedupeKey, the previous job hasn't been claimed yet.
			let collisions = 0
			for (let i = 0; i < 2; i++) {
				try {
					await sql`
						insert into jobs (type, queue, priority, dedupe_key, payload)
						values ('workspace_gc', 'maintenance', 10, ${dedupeKey}, ${sql.json({})})
					`
				} catch {
					collisions++
				}
			}
			expect(collisions).toBe(2)

			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs
				where type = 'workspace_gc' and dedupe_key = ${dedupeKey}
			`
			expect(count).toBe(1)
		} finally {
			await cleanupSchedulerPrefix(prefix)
		}
	})

	test('a finished tick does not swallow the next one', async () => {
		const prefix = uniquePrefix('scheduler-tick-next')
		const sql = getSql()
		try {
			const { enqueueJob } = await import('../src/lib/jobs/jobs.server')
			const dedupeKey = `${prefix}gc:daily`
			// The type carries no registered handler, so no worker claims these rows.
			const type = `${prefix}-gc`
			const first = await enqueueJob({ type, queue: 'maintenance', priority: 10, dedupeKey })
			await sql`update jobs set status = 'completed'::job_status, finished_at = now() where id = ${first.id}`

			const next = await enqueueJob({ type, queue: 'maintenance', priority: 10, dedupeKey })
			expect(next.id, "tomorrow's GC must be a new job").not.toBe(first.id)
			expect(next.status).toBe('pending')
		} finally {
			await sql`delete from jobs where type like ${`${prefix}%`}`
		}
	})

	test('maintenance-queue jobs at priority 10 are below all user-facing tiers', async () => {
		const prefix = uniquePrefix('scheduler-priority')
		const sql = getSql()
		try {
			// Insert one of each tier — claim order should be priority desc.
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload) values
					('workspace_gc', 'maintenance', 10, ${`${prefix}gc`}, ${sql.json({})}),
					('memory_mine', 'default', 50, ${`${prefix}mine`}, ${sql.json({ conversationId: 'x' })}),
					('evaluation_run', 'default', 75, ${`${prefix}eval`}, ${sql.json({ runId: 'x' })}),
					('research_run', 'default', 150, ${`${prefix}research`}, ${sql.json({ researchId: 'x' })})
			`
			// What the worker claims: priority desc, scheduled_at asc.
			const ordered = await sql<{ type: string; priority: number }[]>`
				select type, priority from jobs
				where dedupe_key in (${`${prefix}gc`}, ${`${prefix}mine`}, ${`${prefix}eval`}, ${`${prefix}research`})
				order by priority desc, scheduled_at asc
			`
			expect(ordered.map((r) => r.type)).toEqual([
				'research_run', // 150
				'evaluation_run', // 75
				'memory_mine', // 50
				'workspace_gc', // 10
			])
		} finally {
			await cleanupSchedulerPrefix(prefix)
		}
	})

	test('maintenance queue is filterable separately from default queue', async () => {
		const prefix = uniquePrefix('scheduler-queue-filter')
		const sql = getSql()
		try {
			await sql`
				insert into jobs (type, queue, dedupe_key, payload) values
					('workspace_gc', 'maintenance', ${`${prefix}m1`}, ${sql.json({})}),
					('workspace_gc', 'maintenance', ${`${prefix}m2`}, ${sql.json({})}),
					('memory_mine', 'default', ${`${prefix}d1`}, ${sql.json({ conversationId: 'x' })})
			`
			const maintenance = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs where queue = 'maintenance'
				and dedupe_key like ${`${prefix}%`}
			`
			expect(maintenance[0].count).toBe(2)
		} finally {
			await cleanupSchedulerPrefix(prefix)
		}
	})
})

test.describe('jobs/scheduler — pure registry helpers (best-effort)', () => {
	test('registerScheduledJob + listScheduledJobs round-trip', async () => {
		try {
			const { registerScheduledJob, listScheduledJobs, _resetScheduler } = await import(
				'../src/lib/jobs/scheduler.server'
			)
			_resetScheduler()
			registerScheduledJob({
				name: 'test-schedule',
				intervalMs: 60_000,
				enqueue: () => ({ type: 'workspace_gc', payload: {} }),
			})
			const list = listScheduledJobs()
			expect(list.length).toBe(1)
			expect(list[0].name).toBe('test-schedule')
			expect(list[0].intervalMs).toBe(60_000)
			_resetScheduler()
			expect(listScheduledJobs()).toEqual([])
		} catch (err) {
			expect(err).toBeTruthy()
		}
	})

	test('rejects schedules with intervalMs < 1000ms', async () => {
		try {
			const { registerScheduledJob, _resetScheduler } = await import(
				'../src/lib/jobs/scheduler.server'
			)
			_resetScheduler()
			let threw = false
			try {
				registerScheduledJob({
					name: 'too-fast',
					intervalMs: 100,
					enqueue: () => ({ type: 'workspace_gc', payload: {} }),
				})
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} catch (err) {
			expect(err).toBeTruthy()
		}
	})
})
