import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * A job whose worker died mid-handler is recovered by the next claim.
 *
 * `beginJob` moves every claimed job to `running` before its handler starts, and heartbeats
 * keep extending the lease on that `running` row. The claim query used to reclaim lapsed
 * leases only for `leased` rows, so when a process died mid-handler — a deploy, a crash, a
 * SIGTERM to scripts/worker.ts — the job stayed `running` forever. For automations that
 * wedged the schedule: every dispatch tick collided with the dead row.
 *
 * These specs call the real `claimNextJob`, filtered to a spec-prefixed job type so the
 * claim can only ever see rows this file inserted.
 */

type JobState = {
	id: string
	status: string
	attempt_count: number
	error: { message?: string } | null
	lease_expires_at: Date | null
}

async function insertJob(
	type: string,
	fields: { status: 'leased' | 'running'; attemptCount: number; maxAttempts?: number; leaseLapsedMs: number },
) {
	const sql = getSql()
	const leaseExpiresAt = new Date(Date.now() - fields.leaseLapsedMs)
	const [row] = await sql<{ id: string }[]>`
		insert into jobs (type, status, attempt_count, max_attempts, lease_expires_at, started_at)
		values (
			${type}, ${fields.status}::job_status, ${fields.attemptCount}, ${fields.maxAttempts ?? 3},
			${leaseExpiresAt}, ${fields.status === 'running' ? leaseExpiresAt : null}
		)
		returning id
	`
	return row.id
}

async function readJob(id: string): Promise<JobState> {
	const sql = getSql()
	const [row] = await sql<JobState[]>`
		select id, status::text as status, attempt_count, error, lease_expires_at from jobs where id = ${id}
	`
	return row
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where job_id in (select id from jobs where type like ${`${prefix}%`})`
	await sql`delete from jobs where type like ${`${prefix}%`}`
}

test.describe('jobs/reclaim — a running job whose lease lapsed', () => {
	test('is claimed again when attempts remain and its worker died recently', async () => {
		const prefix = uniquePrefix('reclaim-running')
		const type = `${prefix}-t`
		try {
			const id = await insertJob(type, { status: 'running', attemptCount: 1, leaseLapsedMs: 60_000 })
			const { claimNextJob } = await import('../src/lib/jobs/jobs.server')
			const claimed = await claimNextJob({ workerId: 'spec-worker', types: [type], leaseTtlMs: 30_000 })

			expect(claimed?.id, 'the dead worker’s job is handed to the next worker').toBe(id)
			expect(claimed?.status).toBe('leased')
			expect(claimed!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())

			const sql = getSql()
			const [lease] = await sql<{ worker_id: string }[]>`
				select worker_id from job_leases where job_id = ${id} order by heartbeat_at desc limit 1
			`
			expect(lease.worker_id).toBe('spec-worker')
		} finally {
			await cleanup(prefix)
		}
	})

	test('is left alone while its lease is still live', async () => {
		const prefix = uniquePrefix('reclaim-live')
		const type = `${prefix}-t`
		try {
			// A negative lapse is a lease that expires a minute from now.
			const id = await insertJob(type, { status: 'running', attemptCount: 1, leaseLapsedMs: -60_000 })
			const { claimNextJob } = await import('../src/lib/jobs/jobs.server')
			const claimed = await claimNextJob({ workerId: 'spec-worker', types: [type] })

			expect(claimed).toBeNull()
			expect((await readJob(id)).status).toBe('running')
		} finally {
			await cleanup(prefix)
		}
	})

	test('is failed with a job_stuck review item when it has no attempts left', async () => {
		const prefix = uniquePrefix('reclaim-exhausted')
		const type = `${prefix}-t`
		try {
			// Three attempts used, three allowed: the handler has now taken three workers down
			// with it, so handing it to a fourth is the one thing not to do.
			const id = await insertJob(type, { status: 'running', attemptCount: 3, maxAttempts: 3, leaseLapsedMs: 60_000 })
			const { claimNextJob } = await import('../src/lib/jobs/jobs.server')
			const claimed = await claimNextJob({ workerId: 'spec-worker', types: [type] })

			expect(claimed).toBeNull()
			const job = await readJob(id)
			expect(job.status).toBe('failed')
			expect(job.lease_expires_at).toBeNull()
			expect(job.error?.message).toContain('no attempts are left')

			const sql = getSql()
			const items = await sql<{ type: string }[]>`
				select type::text as type from review_items where job_id = ${id}
			`
			expect(items.map((i) => i.type)).toEqual(['job_stuck'])
		} finally {
			await cleanup(prefix)
		}
	})

	test('is failed rather than resumed when its worker died long ago', async () => {
		const prefix = uniquePrefix('reclaim-abandoned')
		const type = `${prefix}-t`
		try {
			const id = await insertJob(type, { status: 'running', attemptCount: 1, leaseLapsedMs: 3 * 60 * 60_000 })
			const { claimNextJob } = await import('../src/lib/jobs/jobs.server')
			const claimed = await claimNextJob({ workerId: 'spec-worker', types: [type] })

			expect(claimed).toBeNull()
			const job = await readJob(id)
			expect(job.status).toBe('failed')
			expect(job.error?.message).toContain('too long ago to resume')
		} finally {
			await cleanup(prefix)
		}
	})

	test('a retired job does not stop the same claim from returning real work behind it', async () => {
		const prefix = uniquePrefix('reclaim-then-claim')
		const type = `${prefix}-t`
		const sql = getSql()
		try {
			const dead = await insertJob(type, { status: 'running', attemptCount: 3, maxAttempts: 3, leaseLapsedMs: 60_000 })
			// Lower priority, so the dead row is the first candidate the claim sees.
			const [pending] = await sql<{ id: string }[]>`
				insert into jobs (type, priority) values (${type}, 1) returning id
			`
			const { claimNextJob } = await import('../src/lib/jobs/jobs.server')
			const claimed = await claimNextJob({ workerId: 'spec-worker', types: [type] })

			expect(claimed?.id).toBe(pending.id)
			expect((await readJob(dead)).status).toBe('failed')
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('jobs/reclaim — a leased job whose lease lapsed', () => {
	test('is claimed again whatever its attempt count, since its handler never started', async () => {
		const prefix = uniquePrefix('reclaim-leased')
		const type = `${prefix}-t`
		try {
			const id = await insertJob(type, { status: 'leased', attemptCount: 3, maxAttempts: 3, leaseLapsedMs: 60_000 })
			const { claimNextJob } = await import('../src/lib/jobs/jobs.server')
			const claimed = await claimNextJob({ workerId: 'spec-worker', types: [type] })
			expect(claimed?.id).toBe(id)
			expect(claimed?.status).toBe('leased')
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('jobs/reclaim — staleRunningJobVerdict', () => {
	test('re-leases with attempts left and a recent lapse; fails otherwise', async () => {
		const { staleRunningJobVerdict } = await import('../src/lib/jobs/jobs.server')
		const minutes = (m: number) => m * 60_000

		expect(staleRunningJobVerdict({ attemptCount: 1, maxAttempts: 3, leaseLapsedMs: minutes(2) })).toBeNull()
		expect(staleRunningJobVerdict({ attemptCount: 2, maxAttempts: 3, leaseLapsedMs: minutes(59) })).toBeNull()
		expect(staleRunningJobVerdict({ attemptCount: 3, maxAttempts: 3, leaseLapsedMs: minutes(2) })).toMatch(
			/no attempts are left/,
		)
		expect(staleRunningJobVerdict({ attemptCount: 1, maxAttempts: 3, leaseLapsedMs: minutes(61) })).toMatch(/too long ago/)
	})
})
