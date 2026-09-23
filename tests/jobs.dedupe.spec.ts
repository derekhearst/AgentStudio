import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Enqueue dedupe covers ACTIVE jobs only, unless the caller asks for `forever`.
 *
 * `(type, dedupe_key)` used to be a plain unique constraint over every row. Nothing deletes
 * finished jobs, so each fixed key was single-use for the life of the database: the first
 * `automations:dispatch` tick completed, and every later tick's enqueue collided with that
 * completed row and got it back. Scheduled automations, monitors, PR CI polling and memory
 * mining each ran once and never again, with nothing logged.
 *
 * These specs drive the real `enqueueJob` / `enqueueJobWithOutcome` and
 * `checkAndRunAutomations` against the database. Job types carry the spec prefix so nothing
 * here collides with a registered handler — no worker will claim these rows.
 */

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type like ${`${prefix}%`}`
}

async function finish(jobId: string, status: 'completed' | 'failed' | 'canceled') {
	const sql = getSql()
	await sql`
		update jobs set status = ${status}::job_status, finished_at = now(), updated_at = now()
		where id = ${jobId}
	`
}

test.describe('jobs/dedupe — active scope (the default)', () => {
	test('a re-enqueue collapses onto a queued job, then gets a fresh job once it has finished', async () => {
		const prefix = uniquePrefix('dedupe-active')
		const type = `${prefix}-dispatch`
		try {
			const { enqueueJobWithOutcome } = await import('../src/lib/jobs/jobs.server')

			const first = await enqueueJobWithOutcome({ type, dedupeKey: 'tick:fixed' })
			expect(first.created).toBe(true)

			// Still pending: the second tick collapses onto it.
			const second = await enqueueJobWithOutcome({ type, dedupeKey: 'tick:fixed' })
			expect(second.created).toBe(false)
			expect(second.job.id).toBe(first.job.id)

			// The regression: once the first job completes, the key must be free again.
			await finish(first.job.id, 'completed')
			const third = await enqueueJobWithOutcome({ type, dedupeKey: 'tick:fixed' })
			expect(third.created, 'a completed job must not swallow the next tick').toBe(true)
			expect(third.job.id).not.toBe(first.job.id)
			expect(third.job.status).toBe('pending')
		} finally {
			await cleanup(prefix)
		}
	})

	test('failed and canceled jobs free the key too', async () => {
		const prefix = uniquePrefix('dedupe-terminal')
		const type = `${prefix}-t`
		try {
			const { enqueueJob } = await import('../src/lib/jobs/jobs.server')
			const failed = await enqueueJob({ type, dedupeKey: 'k' })
			await finish(failed.id, 'failed')
			const afterFailed = await enqueueJob({ type, dedupeKey: 'k' })
			expect(afterFailed.id).not.toBe(failed.id)

			await finish(afterFailed.id, 'canceled')
			const afterCanceled = await enqueueJob({ type, dedupeKey: 'k' })
			expect(afterCanceled.id).not.toBe(afterFailed.id)
		} finally {
			await cleanup(prefix)
		}
	})

	test('every in-flight status still collapses a re-enqueue', async () => {
		const prefix = uniquePrefix('dedupe-inflight')
		const type = `${prefix}-t`
		const sql = getSql()
		try {
			const { enqueueJobWithOutcome } = await import('../src/lib/jobs/jobs.server')
			const first = await enqueueJobWithOutcome({ type, dedupeKey: 'k' })
			for (const status of ['leased', 'running', 'retry_wait'] as const) {
				await sql`update jobs set status = ${status}::job_status where id = ${first.job.id}`
				const again = await enqueueJobWithOutcome({ type, dedupeKey: 'k' })
				expect(again.created, `a ${status} job must collapse the re-enqueue`).toBe(false)
				expect(again.job.id).toBe(first.job.id)
			}
		} finally {
			await cleanup(prefix)
		}
	})

	test('the database refuses two active rows with one key, but not an active row beside finished ones', async () => {
		const prefix = uniquePrefix('dedupe-index')
		const type = `${prefix}-t`
		const sql = getSql()
		try {
			await sql`insert into jobs (type, dedupe_key, status) values (${type}, 'k', 'completed'::job_status)`
			await sql`insert into jobs (type, dedupe_key, status) values (${type}, 'k', 'failed'::job_status)`
			await sql`insert into jobs (type, dedupe_key, status) values (${type}, 'k', 'pending'::job_status)`
			let threw = false
			try {
				await sql`insert into jobs (type, dedupe_key, status) values (${type}, 'k', 'running'::job_status)`
			} catch {
				threw = true
			}
			expect(threw, 'a second active row with the same key must be rejected').toBe(true)
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('jobs/dedupe — forever scope', () => {
	test('the lookup it depends on is indexed over every row, not just the active ones', async () => {
		// The partial unique index cannot answer "newest job with this key, whatever its
		// status", so without a plain index a forever enqueue scanned the type's whole history.
		const sql = getSql()
		const [index] = await sql<{ indexdef: string }[]>`
			select indexdef from pg_indexes where tablename = 'jobs' and indexname = 'jobs_type_dedupe_idx'
		`
		expect(index?.indexdef).toMatch(/\(type, dedupe_key\)$/)
	})

	test('collapses onto a finished job, so at-most-once work stays at most once', async () => {
		const prefix = uniquePrefix('dedupe-forever')
		const type = `${prefix}-eval`
		try {
			const { enqueueJobWithOutcome } = await import('../src/lib/jobs/jobs.server')
			const first = await enqueueJobWithOutcome({ type, dedupeKey: 'eval:run-1', dedupeScope: 'forever' })
			expect(first.created).toBe(true)
			await finish(first.job.id, 'completed')

			const again = await enqueueJobWithOutcome({ type, dedupeKey: 'eval:run-1', dedupeScope: 'forever' })
			expect(again.created).toBe(false)
			expect(again.job.id).toBe(first.job.id)
			expect(again.job.status).toBe('completed')

			// The same key under the default scope would have queued a second run.
			const active = await enqueueJobWithOutcome({ type, dedupeKey: 'eval:run-1' })
			expect(active.created).toBe(true)
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('jobs/dedupe — automation slots', () => {
	/**
	 * `checkAndRunAutomations` keys each run on its scheduled slot with `forever`, because a
	 * failed first attempt completes its job (the handler swallows the error and queues its
	 * own retry) while the slot stays due. A key that only covered active jobs would start a
	 * fresh attempt-1 chain every minute beside the retries.
	 *
	 * The slot is far in the past so it sorts first among due automations, whatever other
	 * specs have left behind.
	 */
	const SLOT = new Date('2000-01-01T00:00:00.000Z')
	const SLOT_KEY_SUFFIX = '2000-01-01T00:00'

	type ChainJobStatus = 'completed' | 'failed' | 'canceled' | 'pending'

	/**
	 * Insert the automation disabled, give its slot the job under test, then enable it — so
	 * a scheduler tick landing in between cannot queue a real run for the slot first.
	 *
	 * `retries` builds the chain the handler leaves behind when an attempt fails: the failed
	 * attempt's job ends `completed` with `{ retrying: true, retryJobId }` pointing at the next
	 * attempt's job, and the last entry is how the newest attempt stands. A pending retry is
	 * scheduled far ahead so no worker picks it up during the test.
	 */
	async function insertDueAutomationWithSlotJob(
		prefix: string,
		slotJobStatus: ChainJobStatus,
		retries: ChainJobStatus[] = [],
	) {
		const sql = getSql()
		const userId = await getActiveUserId()
		const [automation] = await sql<{ id: string }[]>`
			insert into automations (user_id, description, cron_expression, prompt, next_run_at, enabled)
			values (${userId}, ${`${prefix} slot`}, '0 9 * * *', ${`${prefix} prompt`}, ${SLOT}, false)
			returning id
		`
		const insertJob = async (status: ChainJobStatus, dedupeKey: string, attempt: number) => {
			const [job] = await sql<{ id: string }[]>`
				insert into jobs (type, status, dedupe_key, payload, user_id, scheduled_at, finished_at)
				values (
					'automation_run', ${status}::job_status, ${dedupeKey},
					${sql.json({ automationId: automation.id, attempt, trigger: 'schedule' })}, ${userId},
					${status === 'pending' ? new Date('2999-01-01T00:00:00.000Z') : new Date()},
					${status === 'pending' ? null : new Date()}
				)
				returning id
			`
			return job.id
		}

		const chain = [slotJobStatus, ...retries]
		const ids: string[] = []
		for (let i = 0; i < chain.length; i += 1) {
			const key = i === 0 ? `automation:${automation.id}:${SLOT_KEY_SUFFIX}` : `automation_retry:${ids[i - 1]}:${i + 1}`
			ids.push(await insertJob(chain[i], key, i + 1))
		}
		// Link each failed attempt to the retry it queued, the way `executeAutomationRunJob` does.
		for (let i = 0; i < ids.length - 1; i += 1) {
			await sql`
				update jobs set result = ${sql.json({ status: 'failed', retrying: true, retryJobId: ids[i + 1] })}
				where id = ${ids[i]}
			`
		}

		await sql`update automations set enabled = true where id = ${automation.id}`
		return { automationId: automation.id, slotJobId: ids[0], newestJobId: ids[ids.length - 1] }
	}

	async function readSchedule(automationId: string) {
		const sql = getSql()
		const [row] = await sql<{ next_run_at: Date; last_run_at: Date | null }[]>`
			select next_run_at, last_run_at from automations where id = ${automationId}
		`
		return row
	}

	async function countSlotJobs(automationId: string) {
		const sql = getSql()
		const [{ count }] = await sql<{ count: number }[]>`
			select count(*)::int as count from jobs
			where type = 'automation_run' and payload->>'automationId' = ${automationId}
		`
		return count
	}

	async function cleanupAutomation(prefix: string, automationId: string | null) {
		const sql = getSql()
		if (automationId) {
			await sql`delete from jobs where type = 'automation_run' and payload->>'automationId' = ${automationId}`
			await sql`delete from automation_runs where automation_id = ${automationId}`
		}
		await sql`delete from automations where description like ${`${prefix}%`}`
	}

	test('a slot whose retry is still waiting is neither queued again nor skipped', async () => {
		const prefix = uniquePrefix('dedupe-slot-retrying')
		let automationId: string | null = null
		try {
			// Attempt 1 failed and queued attempt 2, which has not run yet.
			const inserted = await insertDueAutomationWithSlotJob(prefix, 'completed', ['pending'])
			automationId = inserted.automationId

			const { checkAndRunAutomations } = await import('../src/lib/automations/engine')
			const result = await checkAndRunAutomations(new Date())
			const entry = result.enqueued.find((e) => e.automationId === automationId)
			expect(entry?.jobId).toBe(inserted.slotJobId)
			expect(entry?.created).toBe(false)
			expect(entry?.skipped, 'the retry may still succeed, so the slot stays').toBeUndefined()

			expect(await countSlotJobs(automationId), 'no second attempt-1 job beside the retry').toBe(2)
			expect((await readSchedule(automationId)).next_run_at.getTime(), 'the slot is still due').toBe(SLOT.getTime())
		} finally {
			await cleanupAutomation(prefix, automationId)
		}
	})

	test('a slot whose job the queue gave up on is skipped instead of wedging the automation', async () => {
		const prefix = uniquePrefix('dedupe-slot-dead')
		let automationId: string | null = null
		try {
			const inserted = await insertDueAutomationWithSlotJob(prefix, 'failed')
			automationId = inserted.automationId

			const now = new Date()
			const { checkAndRunAutomations } = await import('../src/lib/automations/engine')
			const result = await checkAndRunAutomations(now)
			const entry = result.enqueued.find((e) => e.automationId === automationId)
			expect(entry?.skipped).toBe('slot job failed')

			const row = await readSchedule(automationId)
			expect(row.next_run_at.getTime(), 'the schedule rolled past the dead slot').toBeGreaterThan(now.getTime())
			expect(row.last_run_at, 'nothing ran, so lastRunAt is untouched').toBeNull()
		} finally {
			await cleanupAutomation(prefix, automationId)
		}
	})

	test('a slot whose RETRY the queue gave up on is skipped too', async () => {
		// The common shape of a dead slot. A failed attempt completes its own job and queues
		// the next attempt, so when the queue later retires that retry — its lease lapsed during
		// a long outage, or it crash-looped out of attempts — the slot's job reads `completed`.
		// Checking only the slot job's status left the automation due on this slot for good.
		const prefix = uniquePrefix('dedupe-slot-retry-dead')
		let automationId: string | null = null
		try {
			const inserted = await insertDueAutomationWithSlotJob(prefix, 'completed', ['failed'])
			automationId = inserted.automationId

			const now = new Date()
			const { checkAndRunAutomations } = await import('../src/lib/automations/engine')
			const result = await checkAndRunAutomations(now)
			const entry = result.enqueued.find((e) => e.automationId === automationId)
			expect(entry?.skipped).toBe('retry job failed')
			expect(entry?.jobId, 'the entry names the job the chain ended on').toBe(inserted.newestJobId)

			const row = await readSchedule(automationId)
			expect(row.next_run_at.getTime(), 'the schedule rolled past the dead slot').toBeGreaterThan(now.getTime())
			expect(row.last_run_at).toBeNull()
			expect(await countSlotJobs(automationId), 'skipping queues nothing').toBe(2)
		} finally {
			await cleanupAutomation(prefix, automationId)
		}
	})

	test('the chain is followed to its newest job — a retry canceled two links down still frees the slot', async () => {
		const prefix = uniquePrefix('dedupe-slot-retry-canceled')
		let automationId: string | null = null
		try {
			const inserted = await insertDueAutomationWithSlotJob(prefix, 'completed', ['completed', 'canceled'])
			automationId = inserted.automationId

			const now = new Date()
			const { checkAndRunAutomations } = await import('../src/lib/automations/engine')
			const result = await checkAndRunAutomations(now)
			expect(result.enqueued.find((e) => e.automationId === automationId)?.skipped).toBe('retry job canceled')
			expect((await readSchedule(automationId)).next_run_at.getTime()).toBeGreaterThan(now.getTime())
		} finally {
			await cleanupAutomation(prefix, automationId)
		}
	})

	test('a finished slot that nothing moved on is never queued again, and is skipped', async () => {
		// A chain that finished without moving the schedule — here a slot job that completed
		// with no retry — can never move it later either.
		const prefix = uniquePrefix('dedupe-slot-ran')
		let automationId: string | null = null
		try {
			const inserted = await insertDueAutomationWithSlotJob(prefix, 'completed')
			automationId = inserted.automationId

			const now = new Date()
			const { checkAndRunAutomations } = await import('../src/lib/automations/engine')
			const result = await checkAndRunAutomations(now)
			const entry = result.enqueued.find((e) => e.automationId === automationId)
			expect(entry?.jobId).toBe(inserted.slotJobId)
			expect(entry?.created).toBe(false)
			expect(entry?.skipped).toBe('slot job completed')

			expect(await countSlotJobs(automationId), 'no second attempt-1 job for the same slot').toBe(1)
			expect((await readSchedule(automationId)).next_run_at.getTime()).toBeGreaterThan(now.getTime())
		} finally {
			await cleanupAutomation(prefix, automationId)
		}
	})
})
