import { command, query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { cancelJob, enqueueJob } from '$lib/jobs/jobs.server'
import {
	createResearch,
	getResearchById,
	getResearchDetail,
	listResearchForUser,
	updateResearch,
} from './research.server'

/**
 * Wave 4 #18 phase 3 — Research SvelteKit remote surface.
 *
 * `startResearchCommand` is the user-facing entry point: creates a research row + enqueues
 * a `research_run` job so the loop runs in the background (job worker, not the request
 * handler). Returns the research id immediately so the UI can navigate + poll for status.
 *
 * All queries enforce per-user ownership at the server boundary.
 */

async function ensureResearchOwned(researchId: string, userId: string) {
	const research = await getResearchById(researchId)
	if (!research) throw new Error(`Research ${researchId} not found`)
	if (research.userId !== userId) throw new Error('Not authorized')
	return research
}

export const listResearchQuery = query(
	z
		.object({
			limit: z.number().int().min(1).max(100).optional(),
			status: z
				.enum(['planning', 'searching', 'fetching', 'reflecting', 'synthesizing', 'complete', 'failed', 'canceled'])
				.optional(),
		})
		.default({}),
	async (input) => {
		const user = requireAuthenticatedRequestUser()
		return listResearchForUser(user.id, input)
	},
)

export const getResearchDetailQuery = query(z.string().uuid(), async (researchId) => {
	const user = requireAuthenticatedRequestUser()
	await ensureResearchOwned(researchId, user.id)
	return getResearchDetail(researchId)
})

const startResearchSchema = z.object({
	query: z.string().trim().min(8).max(2000),
	conversationId: z.string().uuid().optional(),
	runId: z.string().uuid().optional(),
	// Composer-selected model. Drives both planner and synthesizer phases; falls back to
	// per-agent config or DEFAULT_RESEARCH_CONFIG when omitted (e.g. automation-triggered runs).
	model: z.string().trim().min(1).max(200).optional(),
})

export const startResearchCommand = command(startResearchSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const research = await createResearch({
		userId: user.id,
		query: input.query,
		conversationId: input.conversationId ?? null,
		runId: input.runId ?? null,
		model: input.model ?? null,
	})
	const job = await enqueueJob({
		type: 'research_run',
		queue: 'default',
		priority: 150, // user-initiated research outranks background work
		payload: { researchId: research.id },
		userId: user.id,
		runId: input.runId ?? null,
	})
	// Backlink the job to the research row for UI traceability.
	await updateResearch(research.id, { jobId: job.id })
	return { research: { ...research, jobId: job.id }, jobId: job.id }
})

export const cancelResearchCommand = command(z.string().uuid(), async (researchId) => {
	const user = requireAuthenticatedRequestUser()
	const research = await ensureResearchOwned(researchId, user.id)
	// Wave 4 #17 phase 3 — flip the research row + ALSO cancel the underlying job so the
	// worker stops at the next safe boundary. Without the job-cancel, the worker would keep
	// going and complete the research even after the user clicked cancel.
	await updateResearch(researchId, { status: 'canceled', finishedAt: new Date() })
	if (research.jobId) {
		await cancelJob(research.jobId, `Canceled by user ${user.id}`).catch((err) => {
			console.warn('[research] failed to cancel underlying job', err)
		})
	}
	return { canceled: true, jobCanceled: !!research.jobId }
})
