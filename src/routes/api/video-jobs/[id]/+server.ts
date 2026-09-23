import { error, json } from '@sveltejs/kit'
import { pollVideoGenJob } from '$lib/llm/video-generation.server'
import { settleVideoJobCost } from '$lib/costs/media-spend.server'
import { logger } from '$lib/observability/logger'
import { requireAuth } from '$lib/server/api-route'

/*
 * `video_generate` hands this URL back when a job outlasts its wait. Whoever polls it first
 * after the job finishes also records the job's cost — the provider bills it then, and the
 * tool is long gone. The reconcile job covers a job nobody polls.
 */

export const GET = requireAuth<{ id: string }>(async ({ params }) => {
	const id = params.id
	if (!id) {
		throw error(400, 'Missing video job id')
	}

	try {
		const job = await pollVideoGenJob(id)
		await settleVideoJobCost(job).catch((err) => logger.warn('[api/video-jobs] cost settle failed', { err }))
		return json(job)
	} catch (err) {
		logger.error('[api/video-jobs] poll failed', { err })
		throw error(502, err instanceof Error ? err.message : 'Video job poll failed')
	}
})
