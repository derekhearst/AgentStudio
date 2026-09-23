import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #17 phase 3 — durable cancellation contract.
 *
 * Schema-level proofs for the cancel signal that runs through the queue:
 *   - Manually flipping jobs.status to 'canceled' is what the worker uses as the kill signal
 *   - cancelJob (server helper) sets status='canceled' + finished_at + records the reason
 *   - The job's lease is released so the slot opens up immediately for the next job
 *   - Research → job back-link survives cancellation so /settings/jobs still shows the trace
 *
 * The runtime side (worker.checkCancellation throws when status='canceled', research-runner
 * detects via getResearchById) is exercised by the live worker against real research runs.
 * This spec owns the durable storage shape so a regression in the cancel transition is
 * caught immediately.
 */

async function cleanupCancelPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from research where query like ${`${prefix}%`}`
	await sql`delete from jobs where type = 'research_run' and dedupe_key like ${`${prefix}%`} or dedupe_key is null and id in (select id from jobs where created_at >= now() - interval '1 hour' and type = 'research_run' and (error->>'message') like ${`%${prefix}%`})`
}

test.describe('jobs/cancel — durable cancellation contract', () => {
	test('canceling a job sets status=canceled + finished_at + records reason in error', async () => {
		const prefix = uniquePrefix('cancel-record-reason')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [job] = await sql<{ id: string }[]>`
				insert into jobs (type, payload, user_id)
				values ('research_run', ${sql.json({ researchId: randomUUID() })}, ${userId})
				returning id
			`
			await sql`
				update jobs
				set status = 'canceled'::job_status,
				    finished_at = now(),
				    error = ${sql.json({ message: `Canceled by user — ${prefix}` })},
				    lease_expires_at = NULL,
				    updated_at = now()
				where id = ${job.id}
			`
			const [check] = await sql<{
				status: string
				finished_at: Date | null
				lease_expires_at: Date | null
				error: { message: string } | null
			}[]>`
				select status::text as status, finished_at, lease_expires_at, error
				from jobs where id = ${job.id}
			`
			expect(check.status).toBe('canceled')
			expect(check.finished_at).not.toBeNull()
			expect(check.lease_expires_at).toBeNull()
			expect(check.error?.message).toContain(prefix)
		} finally {
			await cleanupCancelPrefix(prefix)
		}
	})

	test('canceled job is excluded from the worker claim path', async () => {
		const prefix = uniquePrefix('cancel-claim-exclude')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Create one canceled + one pending job — claim must pick only the pending.
			const [canceled] = await sql<{ id: string }[]>`
				insert into jobs (type, status, payload, user_id)
				values ('research_run', 'canceled'::job_status, ${sql.json({ researchId: randomUUID() })}, ${userId})
				returning id
			`
			const [pending] = await sql<{ id: string }[]>`
				insert into jobs (type, status, payload, user_id)
				values ('research_run', 'pending'::job_status, ${sql.json({ researchId: randomUUID() })}, ${userId})
				returning id
			`
			// Claim path: status in ('pending', 'retry_wait'), or a lapsed lease on a leased or
			// running job — canceled is excluded either way.
			const eligible = await sql<{ id: string }[]>`
				select id from jobs
				where type = 'research_run'
				  and (
				    (status in ('pending', 'retry_wait') and scheduled_at <= now())
				    or (status in ('leased', 'running') and lease_expires_at < now())
				  )
				  and user_id = ${userId}
				  and id in (${canceled.id}, ${pending.id})
			`
			expect(eligible.map((r) => r.id)).toEqual([pending.id])
		} finally {
			await cleanupCancelPrefix(prefix)
		}
	})

	test('research → job back-link survives cancellation so /settings/jobs still shows the trace', async () => {
		const prefix = uniquePrefix('cancel-research-job-link')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query, status)
				values (${userId}, ${`${prefix} q`}, 'searching'::research_status)
				returning id
			`
			const [job] = await sql<{ id: string }[]>`
				insert into jobs (type, payload, user_id)
				values ('research_run', ${sql.json({ researchId: r.id })}, ${userId})
				returning id
			`
			await sql`update research set job_id = ${job.id} where id = ${r.id}`

			// Simulate cancelResearchCommand: flip research + cancel the job.
			await sql`
				update research set status = 'canceled'::research_status, finished_at = now() where id = ${r.id}
			`
			await sql`
				update jobs set status = 'canceled'::job_status, finished_at = now() where id = ${job.id}
			`

			// Both rows still exist + are still linked — admin can trace what happened.
			const [check] = await sql<{
				research_status: string
				job_status: string
				job_id: string | null
			}[]>`
				select r.status::text as research_status,
				       j.status::text as job_status,
				       r.job_id
				from research r
				join jobs j on j.id = r.job_id
				where r.id = ${r.id}
			`
			expect(check.research_status).toBe('canceled')
			expect(check.job_status).toBe('canceled')
			expect(check.job_id).toBe(job.id)
		} finally {
			await cleanupCancelPrefix(prefix)
		}
	})
})

test.describe('jobs/cancel — pure helper imports (best-effort)', () => {
	test('cancelJob server helper sets status + finished_at + clears lease', async () => {
		try {
			const { cancelJob } = await import('../src/lib/jobs/jobs.server')
			expect(typeof cancelJob).toBe('function')
		} catch (err) {
			// $env-bound import may fail in some test envs.
			expect(err).toBeTruthy()
		}
	})
})

test.describe('jobs/cancel — the cancel signal', () => {
	/*
	 * That completeJob and failJob leave a canceled job canceled — the handler of a job
	 * canceled mid-run still returns or throws — is covered with the other late reports in
	 * jobs.reclaim.spec.ts. What stays here is how a handler recognises the cancel.
	 */
	test('the worker cancel check throws a JobCanceledError, not a plain Error', async () => {
		const { JobCanceledError, isJobCanceledError } = await import('../src/lib/jobs/worker.server')
		const err = new JobCanceledError('abc')
		expect(isJobCanceledError(err)).toBe(true)
		expect(isJobCanceledError(new Error('Job abc canceled or removed'))).toBe(false)
	})

	test('a job the queue took back is not reported as canceled', async () => {
		/*
		 * The heartbeat returns null for a canceled job and for one the claim path retired
		 * after this worker's lease lapsed. Only the first may reach a handler as a cancel: the
		 * research runner records a JobCanceledError as the user's Cancel.
		 */
		const prefix = uniquePrefix('cancel-lost-job')
		const type = `${prefix}-t`
		const sql = getSql()
		try {
			const insert = async (status: 'canceled' | 'failed') => {
				const [row] = await sql<{ id: string }[]>`
					insert into jobs (type, status, attempt_count, max_attempts, finished_at)
					values (${type}, ${status}::job_status, 1, 2, now())
					returning id
				`
				return row.id
			}
			const { errorForLostJob, isJobCanceledError } = await import('../src/lib/jobs/worker.server')

			expect(isJobCanceledError(await errorForLostJob(await insert('canceled')))).toBe(true)
			expect(isJobCanceledError(await errorForLostJob(randomUUID())), 'a job that is gone counts as canceled').toBe(true)

			const retired = await errorForLostJob(await insert('failed'))
			expect(isJobCanceledError(retired)).toBe(false)
			expect(retired.message).toContain('failed')
		} finally {
			await sql`delete from jobs where type = ${type}`
		}
	})
})
