import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * A canceled research run stays canceled, and a finished one is never run again.
 *
 * Two bugs, one path. The worker's cancel check threw a plain Error, so the runner recorded
 * the user's cancel as `failed`, the handler threw, and `failJob` — which did not look at
 * the job's status — put the canceled job back on the queue. The retry found nothing
 * canceled any more and ran the research to the end, notification included.
 *
 * And a failed run was retried: the queue's default three attempts re-ran it on a row still
 * carrying the first attempt's plan (then labelled "user approved"), sources and error.
 *
 * These specs drive the runner and the job handler directly. Every row starts at a point
 * where the runner stops before its first model call, so nothing here needs a model.
 */

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type = 'research_run' and payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
	await sql`delete from research where query like ${`${prefix}%`}`
}

async function insertResearch(prefix: string, status: string, extra: { plan?: string[]; error?: string } = {}) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [row] = await sql<{ id: string }[]>`
		insert into research (user_id, query, status, plan, error)
		values (${userId}, ${`${prefix} how do tides work`}, ${status}::research_status, ${sql.json(extra.plan ?? [])}, ${extra.error ?? null})
		returning id
	`
	return row.id
}

async function insertRunningJob(researchId: string) {
	const sql = getSql()
	const userId = await getActiveUserId()
	// `running`, not `pending`: a pending row could be claimed by a dev server's worker.
	const [job] = await sql<{ id: string }[]>`
		insert into jobs (type, status, payload, user_id, attempt_count, max_attempts)
		values ('research_run', 'running'::job_status, ${sql.json({ researchId })}, ${userId}, 1, 3)
		returning id
	`
	return job.id
}

async function readResearch(id: string) {
	const sql = getSql()
	const [row] = await sql<{ status: string; error: string | null; job_id: string | null }[]>`
		select status::text as status, error, job_id from research where id = ${id}
	`
	return row
}

async function readJob(id: string) {
	const sql = getSql()
	const [row] = await sql<{ status: string; max_attempts: number }[]>`
		select status::text as status, max_attempts from jobs where id = ${id}
	`
	return row
}

test.describe('research/cancel — a cancel stays a cancel', () => {
	test('the job cancel signal ends the run as canceled, not failed', async () => {
		const prefix = uniquePrefix('research-cancel-signal')
		try {
			const researchId = await insertResearch(prefix, 'planning')
			const { runResearchLoop } = await import('../src/lib/research/research-runner.server')
			const { JobCanceledError } = await import('../src/lib/jobs/worker.server')

			const outcome = await runResearchLoop(researchId, {
				checkCancellation: async () => {
					throw new JobCanceledError('00000000-0000-0000-0000-000000000000')
				},
			})

			expect(outcome.status).toBe('canceled')
			const row = await readResearch(researchId)
			expect(row.status).toBe('canceled')
			expect(row.error).toBeNull()
		} finally {
			await cleanup(prefix)
		}
	})

	test('any other error from the cancel check is a failure, not a cancel', async () => {
		const prefix = uniquePrefix('research-cancel-db-error')
		try {
			const researchId = await insertResearch(prefix, 'planning')
			const { runResearchLoop } = await import('../src/lib/research/research-runner.server')

			const outcome = await runResearchLoop(researchId, {
				checkCancellation: async () => {
					throw new Error('connection terminated unexpectedly')
				},
			})

			expect(outcome.status).toBe('failed')
			const row = await readResearch(researchId)
			expect(row.status).toBe('failed')
			expect(row.error).toContain('connection terminated')
		} finally {
			await cleanup(prefix)
		}
	})

	test('the handler returns for a canceled run, and the job is neither completed nor retried', async () => {
		const prefix = uniquePrefix('research-cancel-handler')
		const sql = getSql()
		try {
			const researchId = await insertResearch(prefix, 'planning')
			const jobId = await insertRunningJob(researchId)
			const { runResearchJob } = await import('../src/lib/research/research-handler.server')
			const { JobCanceledError } = await import('../src/lib/jobs/worker.server')
			const { completeJob, failJob, getJobById, heartbeatJob } = await import('../src/lib/jobs/jobs.server')
			const job = await getJobById(jobId)

			// The user presses Cancel while the run is between phases: cancelResearchCommand
			// flips the row and cancels the job. The check then runs the worker's real test.
			let canceledByUser = false
			const result = await runResearchJob({
				job: job!,
				workerId: 'spec',
				checkCancellation: async () => {
					if (!canceledByUser) {
						canceledByUser = true
						await sql`update research set status = 'canceled'::research_status, finished_at = now() where id = ${researchId}`
						await sql`update jobs set status = 'canceled'::job_status, finished_at = now() where id = ${jobId}`
					}
					if (!(await heartbeatJob(jobId))) throw new JobCanceledError(jobId)
				},
			})
			expect(result.status).toBe('canceled')

			// What the worker does next either way: neither write may undo the cancel.
			await completeJob(jobId, result)
			expect((await readJob(jobId)).status).toBe('canceled')
			await failJob(jobId, { error: { message: 'would have been retried' } })
			expect((await readJob(jobId)).status).toBe('canceled')
			expect((await readResearch(researchId)).status).toBe('canceled')
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('research/retry — a finished run is not run again', () => {
	test('a failed row is returned as it stands, with no new steps and the same error', async () => {
		const prefix = uniquePrefix('research-no-rerun')
		const sql = getSql()
		try {
			const researchId = await insertResearch(prefix, 'failed', {
				plan: ['What causes spring tides?'],
				error: 'synthesizer: 502 from provider',
			})
			const { runResearchLoop } = await import('../src/lib/research/research-runner.server')

			const outcome = await runResearchLoop(researchId)

			expect(outcome.status).toBe('failed')
			expect(outcome.alreadyFinished).toBe(true)
			expect(outcome.error).toBe('synthesizer: 502 from provider')
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from research_steps where research_id = ${researchId}
			`
			expect(count, 'nothing ran, so no step was written').toBe(0)
			expect((await readResearch(researchId)).status).toBe('failed')
		} finally {
			await cleanup(prefix)
		}
	})

	test('the handler still reports a failed run as a failed job', async () => {
		const prefix = uniquePrefix('research-failed-job')
		try {
			const researchId = await insertResearch(prefix, 'failed', { error: 'planner returned no sub-questions' })
			const jobId = await insertRunningJob(researchId)
			const { runResearchJob } = await import('../src/lib/research/research-handler.server')
			const { getJobById } = await import('../src/lib/jobs/jobs.server')
			const job = await getJobById(jobId)
			await expect(
				runResearchJob({ job: job!, workerId: 'spec', checkCancellation: async () => undefined }),
			).rejects.toThrow('planner returned no sub-questions')
		} finally {
			await cleanup(prefix)
		}
	})

	test('research jobs are queued with a single attempt and linked to their row', async () => {
		const prefix = uniquePrefix('research-one-attempt')
		try {
			// Already canceled, so a worker that claims the job ends it without running anything.
			const researchId = await insertResearch(prefix, 'canceled')
			const { enqueueResearchRun } = await import('../src/lib/research/research.server')
			const job = await enqueueResearchRun({ researchId, userId: await getActiveUserId(), priority: 150 })

			expect(job.maxAttempts).toBe(1)
			expect((await readJob(job.id)).max_attempts).toBe(1)
			expect((await readResearch(researchId)).job_id).toBe(job.id)
		} finally {
			await cleanup(prefix)
		}
	})
})
