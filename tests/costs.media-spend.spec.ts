import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Image and video generation spend reaches the tool ledger — the table budget limits and
 * the cost summaries actually add up.
 *
 * `image_generate` kept its cost on the `images` row only, so a run of generated images
 * never moved a budget limit. `video_generate` logged a cost only if the job finished inside
 * the tool's wait; a longer job was billed later with nothing recorded. A video job is now
 * a pending ledger row from the moment it is submitted, priced when anything sees it end.
 */

type Row = { cost: string; unit_type: string; units: string; metadata: Record<string, unknown> }

async function readRows(where: { toolName: string; key: string; value: string }): Promise<Row[]> {
	const sql = getSql()
	return sql<Row[]>`
		select cost::text as cost, unit_type, units::text as units, metadata
		from tool_usage
		where tool_name = ${where.toolName} and metadata->>${where.key} = ${where.value}
	`
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from tool_usage where metadata->>'jobId' like ${`${prefix}%`} or metadata->>'model' like ${`${prefix}%`}`
}

test.describe('costs/media-spend — images', () => {
	test('a paid image lands in the tool ledger as a credit row', async () => {
		const prefix = uniquePrefix('image-spend')
		try {
			const { logImageGenerationSpend } = await import('../src/lib/costs/media-spend.server')
			await logImageGenerationSpend({
				cost: 0.04,
				model: `${prefix}/dall-e-3`,
				size: '1024x1024',
				userId: await getActiveUserId(),
				runId: null,
			})
			const rows = await readRows({ toolName: 'image_generate', key: 'model', value: `${prefix}/dall-e-3` })
			expect(rows).toHaveLength(1)
			expect(rows[0].unit_type).toBe('credit')
			expect(parseFloat(rows[0].cost)).toBeCloseTo(0.04, 6)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a free image writes no spend row', async () => {
		const prefix = uniquePrefix('image-free')
		try {
			const { logImageGenerationSpend } = await import('../src/lib/costs/media-spend.server')
			await logImageGenerationSpend({ cost: 0, model: `${prefix}/flux`, size: '512x512', userId: null, runId: null })
			expect(await readRows({ toolName: 'image_generate', key: 'model', value: `${prefix}/flux` })).toHaveLength(0)
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('costs/media-spend — videos', () => {
	test('a submitted job is a pending row, priced once when it completes', async () => {
		const prefix = uniquePrefix('video-settle')
		const jobId = `${prefix}:job-1`
		try {
			const { recordVideoJobSubmitted, settleVideoJobCost } = await import('../src/lib/costs/media-spend.server')
			await recordVideoJobSubmitted({ jobId, model: 'google/veo-3', resolution: '4k', durationSeconds: 60, userId: null, runId: null })

			let [row] = await readRows({ toolName: 'video_generate', key: 'jobId', value: jobId })
			expect(row.metadata.costStatus).toBe('pending')
			expect(parseFloat(row.cost)).toBe(0)
			expect(parseFloat(row.units)).toBe(60)

			expect(await settleVideoJobCost({ jobId, status: 'in_progress', cost: null })).toBe('pending')
			expect(await settleVideoJobCost({ jobId, status: 'completed', cost: 3.2 })).toBe('settled')
			// The poll route and the reconcile job may both see it finish: counted once.
			expect(await settleVideoJobCost({ jobId, status: 'completed', cost: 3.2 })).toBe('already_settled')

			;[row] = await readRows({ toolName: 'video_generate', key: 'jobId', value: jobId })
			expect(row.metadata.costStatus).toBe('settled')
			expect(parseFloat(row.cost)).toBeCloseTo(3.2, 6)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a completed job with no reported cost is marked unpriced, not free', async () => {
		const prefix = uniquePrefix('video-unpriced')
		const jobId = `${prefix}:job-1`
		try {
			const { recordVideoJobSubmitted, settleVideoJobCost } = await import('../src/lib/costs/media-spend.server')
			await recordVideoJobSubmitted({ jobId, model: 'google/veo-3', userId: null, runId: null })
			expect(await settleVideoJobCost({ jobId, status: 'completed', cost: null })).toBe('settled')
			const [row] = await readRows({ toolName: 'video_generate', key: 'jobId', value: jobId })
			expect(row.metadata.unpriced).toBe('no_cost_reported')
		} finally {
			await cleanup(prefix)
		}
	})

	test('the reconcile job prices a job that finished after the tool stopped waiting', async () => {
		const prefix = uniquePrefix('video-reconcile')
		const sql = getSql()
		const done = `${prefix}:done`
		const running = `${prefix}:running`
		const stale = `${prefix}:stale`
		try {
			const { recordVideoJobSubmitted, reconcilePendingVideoJobs } = await import('../src/lib/costs/media-spend.server')
			for (const jobId of [done, running, stale]) {
				await recordVideoJobSubmitted({ jobId, model: 'google/veo-3', durationSeconds: 8, userId: null, runId: null })
			}
			await sql`
				update tool_usage set created_at = now() - interval '3 days'
				where tool_name = 'video_generate' and metadata->>'jobId' = ${stale}
			`

			const polled: string[] = []
			// Other pending rows may exist in a shared database; answer only for ours.
			await reconcilePendingVideoJobs({
				limit: 500,
				poll: async (jobId) => {
					polled.push(jobId)
					if (jobId === done) return { jobId, status: 'completed', cost: 0.9 }
					if (jobId === running) return { jobId, status: 'in_progress', cost: null }
					throw new Error('not this spec’s job')
				},
			})

			expect(polled).toContain(done)
			expect(polled, 'a job past the age limit is not chased').not.toContain(stale)
			const status = async (jobId: string) =>
				(await readRows({ toolName: 'video_generate', key: 'jobId', value: jobId }))[0]
			expect((await status(done)).metadata.costStatus).toBe('settled')
			expect(parseFloat((await status(done)).cost)).toBeCloseTo(0.9, 6)
			expect((await status(running)).metadata.costStatus).toBe('pending')
			expect((await status(stale)).metadata.costStatus).toBe('abandoned')
		} finally {
			await cleanup(prefix)
		}
	})
})
