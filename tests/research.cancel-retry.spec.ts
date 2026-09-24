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
 * carrying the first attempt's plan (then labelled "user approved"), sources and error. The
 * job keeps a second attempt, for a worker that dies mid-run; on a failed row it runs nothing.
 *
 * A Cancel pressed while the report was being written was lost too: nothing looked at the row
 * after the synthesizer answered, so the run saved its report over "canceled", marked itself
 * complete and sent "Research complete".
 *
 * And a run nobody canceled could not finish either: marking the sources its report cited
 * sent Postgres `= ANY(($1))`, which it refuses, so every run that cited a source failed at
 * its last step.
 *
 * These specs drive the runner and the job handler directly. Most rows start at a point where
 * the runner stops before its first model call; the synthesis specs answer the model calls
 * with a stand-in for OpenRouter, so nothing here needs a model.
 */

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type = 'research_run' and payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
	await sql`delete from llm_usage where metadata->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
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

/**
 * Stands in for OpenRouter, so a run gets as far as synthesis without a model. Reflection
 * finds no gaps; the synthesizer's call runs `duringSynthesis` before it answers. Every other
 * request (web search, the price catalogue) is refused, which the runner treats as no results.
 */
async function withFakeOpenRouter<T>(duringSynthesis: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
	const { REFLECTION_SYSTEM, SYNTHESIZER_SYSTEM } = await import('../src/lib/research/research-prompts')
	const realFetch = globalThis.fetch
	const realKey = process.env.OPENROUTER_API_KEY
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		if (!request.url.endsWith('/chat/completions')) return new Response('not here', { status: 404 })
		const body = JSON.parse(await request.text()) as { messages: { content: string }[] }
		const system = body.messages[0]?.content
		let content = '{"gaps": []}'
		if (system === SYNTHESIZER_SYSTEM) {
			await duringSynthesis()
			content = '## Tides\n\nSpring tides follow the new and full moon [1].'
		} else if (system !== REFLECTION_SYSTEM) {
			return new Response('unexpected call', { status: 404 })
		}
		const result = {
			id: 'gen-spec',
			object: 'chat.completion',
			created: 0,
			model: 'anthropic/claude-sonnet-5',
			system_fingerprint: null,
			choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
		}
		return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
	}) as typeof fetch
	process.env.OPENROUTER_API_KEY = realKey || 'sk-test-not-a-real-key'
	try {
		return await fn()
	} finally {
		globalThis.fetch = realFetch
		if (realKey === undefined) delete process.env.OPENROUTER_API_KEY
		else process.env.OPENROUTER_API_KEY = realKey
	}
}

/** A run with its plan and one source in place, so the first model call it makes is reflection. */
async function insertRunReadyToSynthesize(prefix: string) {
	const sql = getSql()
	const researchId = await insertResearch(prefix, 'searching', { plan: ['What causes spring tides?'] })
	await sql`
		insert into research_sources (research_id, url, title, extracted_text)
		values (${researchId}, 'https://example.com/tides', 'Tides', 'Spring tides occur at new and full moon.')
	`
	return researchId
}

/** What cancelResearchCommand does to the row. */
async function cancelRow(researchId: string) {
	const sql = getSql()
	await sql`update research set status = 'canceled'::research_status, finished_at = now() where id = ${researchId}`
}

test.describe('research/cancel — a cancel during synthesis stands', () => {
	// The control for the specs below: the same run, with no Cancel, finishes. It also pins
	// the last step, marking the cited sources, which failed every run whose report cited one.
	test('without a Cancel the same run completes, keeps its report and marks the source it cites', async () => {
		const prefix = uniquePrefix('research-synth-complete')
		const sql = getSql()
		try {
			const researchId = await insertRunReadyToSynthesize(prefix)
			const { runResearchLoop } = await import('../src/lib/research/research-runner.server')

			const outcome = await withFakeOpenRouter(
				async () => undefined,
				() => runResearchLoop(researchId),
			)

			expect(outcome.error ?? null).toBeNull()
			expect(outcome.status).toBe('complete')
			expect(outcome.citedCount).toBe(1)
			const [row] = await sql<{ status: string; report: string | null }[]>`
				select status::text as status, report from research where id = ${researchId}
			`
			expect(row.status).toBe('complete')
			expect(row.report).toContain('Spring tides follow the new and full moon')
			const [{ cited }] = await sql<{ cited: number }[]>`
				select count(*)::int as cited from research_sources where research_id = ${researchId} and cited_in_report
			`
			expect(cited, 'the source the report cites is marked cited').toBe(1)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a Cancel that lands while the report is being written ends the run canceled, with no report', async () => {
		const prefix = uniquePrefix('research-cancel-synth')
		const sql = getSql()
		try {
			const researchId = await insertRunReadyToSynthesize(prefix)
			const { runResearchLoop } = await import('../src/lib/research/research-runner.server')

			const outcome = await withFakeOpenRouter(
				() => cancelRow(researchId),
				() => runResearchLoop(researchId),
			)

			expect(outcome.status).toBe('canceled')
			expect(outcome.report).toBeNull()
			const [row] = await sql<{ status: string; report: string | null }[]>`
				select status::text as status, report from research where id = ${researchId}
			`
			expect(row.status).toBe('canceled')
			expect(row.report, 'the canceled run keeps no report').toBeNull()
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from research_steps where research_id = ${researchId} and kind = 'synthesize'
			`
			expect(count, 'no synthesis step is recorded for a canceled run').toBe(0)
		} finally {
			await cleanup(prefix)
		}
	})

	test('the job handler ends that run canceled and sends no "Research complete"', async () => {
		const prefix = uniquePrefix('research-cancel-synth-job')
		const sql = getSql()
		try {
			const researchId = await insertRunReadyToSynthesize(prefix)
			const jobId = await insertRunningJob(researchId)
			const { runResearchJob } = await import('../src/lib/research/research-handler.server')
			const { getJobById } = await import('../src/lib/jobs/jobs.server')
			const job = await getJobById(jobId)

			const result = await withFakeOpenRouter(
				() => cancelRow(researchId),
				() => runResearchJob({ job: job!, workerId: 'spec', checkCancellation: async () => undefined }),
			)

			expect(result.status).toBe('canceled')
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from notifications where url = ${`/research/${researchId}`}
			`
			expect(count).toBe(0)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a write the runner makes after the row ended changes nothing', async () => {
		const prefix = uniquePrefix('research-guarded-write')
		try {
			const canceledId = await insertResearch(prefix, 'canceled')
			const runningId = await insertResearch(prefix, 'searching')
			const { updateResearchUnlessEnded } = await import('../src/lib/research/research.server')

			expect(await updateResearchUnlessEnded(canceledId, { status: 'synthesizing' })).toBeNull()
			expect(await updateResearchUnlessEnded(canceledId, { status: 'complete', report: '# done' })).toBeNull()
			expect((await readResearch(canceledId)).status).toBe('canceled')

			expect((await updateResearchUnlessEnded(runningId, { status: 'synthesizing' }))?.status).toBe('synthesizing')
			// The runner's own cancel write may land on a canceled row, never on a finished one.
			expect(await updateResearchUnlessEnded(canceledId, { status: 'canceled' }, ['complete', 'failed'])).not.toBeNull()
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

	test('research jobs are queued with one spare attempt, for a dead worker, and linked to their row', async () => {
		const prefix = uniquePrefix('research-two-attempts')
		try {
			// Already canceled, so a worker that claims the job ends it without running anything.
			const researchId = await insertResearch(prefix, 'canceled')
			const { enqueueResearchRun } = await import('../src/lib/research/research.server')
			const job = await enqueueResearchRun({ researchId, userId: await getActiveUserId(), priority: 150 })

			// One attempt would have the claim path fail the job the first time its worker died
			// mid-run (staleRunningJobVerdict), leaving the research row at "searching" for good.
			expect(job.maxAttempts).toBe(2)
			expect((await readJob(job.id)).max_attempts).toBe(2)
			expect((await readResearch(researchId)).job_id).toBe(job.id)
		} finally {
			await cleanup(prefix)
		}
	})
})
