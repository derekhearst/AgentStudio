import { error, json } from '@sveltejs/kit'
import { pollVideoGenJob } from '$lib/llm/video-generation.server'
import { logger } from '$lib/observability/logger'
import { requireAuth } from '$lib/server/api-route'

export const GET = requireAuth<{ id: string }>(async ({ params }) => {
	const id = params.id
	if (!id) {
		throw error(400, 'Missing video job id')
	}

	try {
		const job = await pollVideoGenJob(id)
		return json(job)
	} catch (err) {
		logger.error('[api/video-jobs] poll failed', { err })
		throw error(502, err instanceof Error ? err.message : 'Video job poll failed')
	}
})
