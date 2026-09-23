import { and, asc, desc, eq, inArray, notInArray, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { enqueueJob } from '$lib/jobs/jobs.server'
import type { JobRow } from '$lib/jobs/jobs.schema'
import {
	research,
	researchSources,
	researchSteps,
	type ResearchRow,
	type ResearchSourceRow,
	type ResearchStatus,
	type ResearchStepKind,
	type ResearchStepRow,
} from './research.schema'

/**
 * Wave 4 #18 phase 1 — research domain server helpers.
 *
 * CRUD over `research`, `researchSources`, `researchSteps`. The orchestration loop (Phase 2)
 * + the job worker integration (Phase 3) are layered on top.
 */

export type CreateResearchInput = {
	userId: string | null
	query: string
	conversationId?: string | null
	runId?: string | null
	jobId?: string | null
	// Composer-selected model. Stored on the research row so the orchestrator can override
	// DEFAULT_RESEARCH_CONFIG.{plannerModel,synthesizerModel} for this specific run.
	model?: string | null
}

export async function createResearch(input: CreateResearchInput): Promise<ResearchRow> {
	const [row] = await db
		.insert(research)
		.values({
			userId: input.userId,
			query: input.query,
			conversationId: input.conversationId ?? null,
			runId: input.runId ?? null,
			jobId: input.jobId ?? null,
			model: input.model ?? null,
			status: 'planning',
		})
		.returning()
	return row
}

export type UpdateResearchInput = {
	status?: ResearchStatus
	plan?: string[]
	report?: string | null
	costUsd?: number | string
	tokensUsed?: number
	finishedAt?: Date | null
	error?: string | null
	jobId?: string | null
}

function toResearchUpdate(patch: UpdateResearchInput): Partial<typeof research.$inferInsert> {
	const updates: Partial<typeof research.$inferInsert> = { updatedAt: new Date() }
	if (patch.status !== undefined) updates.status = patch.status
	if (patch.plan !== undefined) updates.plan = patch.plan
	if (patch.report !== undefined) updates.report = patch.report
	if (patch.costUsd !== undefined) updates.costUsd = String(patch.costUsd)
	if (patch.tokensUsed !== undefined) updates.tokensUsed = patch.tokensUsed
	if (patch.finishedAt !== undefined) updates.finishedAt = patch.finishedAt
	if (patch.error !== undefined) updates.error = patch.error
	if (patch.jobId !== undefined) updates.jobId = patch.jobId
	return updates
}

export async function updateResearch(
	researchId: string,
	patch: UpdateResearchInput,
): Promise<ResearchRow | null> {
	const [row] = await db.update(research).set(toResearchUpdate(patch)).where(eq(research.id, researchId)).returning()
	return row ?? null
}

/**
 * Update a research row unless it has already ended. Returns null, having written nothing,
 * when the row is in one of `ended` (by default every final status) or is gone.
 *
 * The runner writes the row at every phase, and the user's Cancel can land between its last
 * look at the row and its next write. Written unconditionally, that next write turned the
 * user's "canceled" back into "searching", or into "complete" with a report and a "Research
 * complete" notification.
 */
export async function updateResearchUnlessEnded(
	researchId: string,
	patch: UpdateResearchInput,
	ended: Iterable<ResearchStatus> = TERMINAL_RESEARCH_STATUSES,
): Promise<ResearchRow | null> {
	const [row] = await db
		.update(research)
		.set(toResearchUpdate(patch))
		.where(and(eq(research.id, researchId), notInArray(research.status, [...ended])))
		.returning()
	return row ?? null
}

/** See `enqueueResearchRun`: the first attempt, and one more if its worker dies. */
export const RESEARCH_RUN_MAX_ATTEMPTS = 2

export type EnqueueResearchRunInput = {
	researchId: string
	userId: string | null
	runId?: string | null
	priority: number
	dedupeKey?: string
}

/**
 * Queue the background run for a research row and link the job back to the row.
 *
 * Two attempts, and the second is only for a run whose worker died. The queue's default was
 * three, and a research run is ten minutes of paid model calls and a few dozen page fetches:
 * a retry after a failure re-ran all of it on a row that still carried the first attempt's
 * error, plan and sources, while the open page had already stopped polling at "failed". The
 * runner now returns an ended row as it stands, so a failed run stays failed — its second
 * attempt ends at once with the same error — and the job lands in the review inbox as a job
 * failure.
 *
 * Not one attempt: the claim path fails a job whose worker died mid-run once it has no
 * attempts left (jobs.server `staleRunningJobVerdict`), so a single attempt would turn every
 * deploy or crash during a run into a "Job stuck" item and a run left at "searching" for
 * good. With a second one, another worker picks the run up from its saved plan and sources.
 */
export async function enqueueResearchRun(input: EnqueueResearchRunInput): Promise<JobRow> {
	const job = await enqueueJob({
		type: 'research_run',
		queue: 'default',
		priority: input.priority,
		payload: { researchId: input.researchId },
		userId: input.userId,
		runId: input.runId ?? null,
		dedupeKey: input.dedupeKey,
		maxAttempts: RESEARCH_RUN_MAX_ATTEMPTS,
	})
	await updateResearch(input.researchId, { jobId: job.id })
	return job
}

/** Research statuses a run ends in. A row in one of these is never run again. */
export const TERMINAL_RESEARCH_STATUSES: ReadonlySet<ResearchStatus> = new Set(['complete', 'failed', 'canceled'])

export async function getResearchById(researchId: string): Promise<ResearchRow | null> {
	const [row] = await db.select().from(research).where(eq(research.id, researchId)).limit(1)
	return row ?? null
}

export async function listResearchForUser(
	userId: string,
	opts: { limit?: number; status?: ResearchStatus } = {},
): Promise<ResearchRow[]> {
	const filters = [eq(research.userId, userId)]
	if (opts.status) filters.push(eq(research.status, opts.status))
	return db
		.select()
		.from(research)
		.where(and(...filters))
		.orderBy(desc(research.createdAt))
		.limit(opts.limit ?? 50)
}

/**
 * List research runs that originated from (or are linked to) a specific conversation. Used by
 * the chat page sidebar to surface the active research run alongside the chat thread. Filters
 * to runs owned by `userId` so a stale conversationId never leaks across users.
 */
export async function listResearchByConversation(
	conversationId: string,
	userId: string,
	limit = 5,
): Promise<ResearchRow[]> {
	return db
		.select()
		.from(research)
		.where(and(eq(research.conversationId, conversationId), eq(research.userId, userId)))
		.orderBy(desc(research.createdAt))
		.limit(limit)
}

export type AddResearchSourceInput = {
	researchId: string
	url: string
	title?: string | null
	extractedText?: string | null
	contentType?: string
	notes?: string | null
	costUsd?: number | string | null
}

export async function addResearchSource(input: AddResearchSourceInput): Promise<ResearchSourceRow> {
	const [row] = await db
		.insert(researchSources)
		.values({
			researchId: input.researchId,
			url: input.url,
			title: input.title ?? null,
			extractedText: input.extractedText ?? null,
			contentType: input.contentType ?? 'html',
			notes: input.notes ?? null,
			costUsd: input.costUsd != null ? String(input.costUsd) : null,
		})
		.returning()
	return row
}

export async function listSourcesForResearch(
	researchId: string,
	opts: { citedOnly?: boolean } = {},
): Promise<ResearchSourceRow[]> {
	const filters = [eq(researchSources.researchId, researchId)]
	if (opts.citedOnly) filters.push(eq(researchSources.citedInReport, true))
	return db
		.select()
		.from(researchSources)
		.where(and(...filters))
		.orderBy(asc(researchSources.fetchedAt))
}

/** The URLs already fetched for a run, so a later pass does not fetch and store them again. */
export async function listSourceUrlsForResearch(researchId: string): Promise<string[]> {
	const rows = await db
		.select({ url: researchSources.url })
		.from(researchSources)
		.where(eq(researchSources.researchId, researchId))
	return rows.map((row) => row.url)
}

export async function countSourcesForResearch(researchId: string): Promise<{ total: number; cited: number }> {
	const [row] = await db
		.select({
			total: drizzleSql<number>`count(*)::int`,
			cited: drizzleSql<number>`count(*) filter (where ${researchSources.citedInReport})::int`,
		})
		.from(researchSources)
		.where(eq(researchSources.researchId, researchId))
	return { total: Number(row?.total ?? 0), cited: Number(row?.cited ?? 0) }
}

/**
 * Flag the sources the report cites. `inArray`, not a hand-written `= ANY(${ids})`: Drizzle
 * spreads an interpolated array into a parenthesised list, so that read `= ANY(($1))` and
 * Postgres refused it. Every run whose report cited a source failed at its last step.
 */
export async function markSourcesCited(
	researchId: string,
	sourceIds: string[],
): Promise<{ updated: number }> {
	if (sourceIds.length === 0) return { updated: 0 }
	const result = await db
		.update(researchSources)
		.set({ citedInReport: true })
		.where(and(eq(researchSources.researchId, researchId), inArray(researchSources.id, sourceIds)))
		.returning({ id: researchSources.id })
	return { updated: result.length }
}

export type AddResearchStepInput = {
	researchId: string
	kind: ResearchStepKind
	subQuestion?: string | null
	payload?: Record<string, unknown>
	costUsd?: number | string | null
	finishedAt?: Date | null
	error?: string | null
}

/**
 * Append a step to the trace. Sequence number is auto-assigned (`max(seq) + 1` per research).
 */
export async function addResearchStep(input: AddResearchStepInput): Promise<ResearchStepRow> {
	return db.transaction(async (tx) => {
		const [maxRow] = await tx
			.select({ max: drizzleSql<number>`coalesce(max(${researchSteps.seq}), 0)::int` })
			.from(researchSteps)
			.where(eq(researchSteps.researchId, input.researchId))
		const nextSeq = (maxRow?.max ?? 0) + 1
		const [row] = await tx
			.insert(researchSteps)
			.values({
				researchId: input.researchId,
				seq: nextSeq,
				kind: input.kind,
				subQuestion: input.subQuestion ?? null,
				payload: input.payload ?? {},
				costUsd: input.costUsd != null ? String(input.costUsd) : null,
				finishedAt: input.finishedAt ?? null,
				error: input.error ?? null,
			})
			.returning()
		return row
	})
}

export async function listStepsForResearch(researchId: string): Promise<ResearchStepRow[]> {
	return db
		.select()
		.from(researchSteps)
		.where(eq(researchSteps.researchId, researchId))
		.orderBy(asc(researchSteps.seq))
}

export type ResearchDetail = {
	research: ResearchRow
	sources: ResearchSourceRow[]
	steps: ResearchStepRow[]
}

export async function getResearchDetail(researchId: string): Promise<ResearchDetail | null> {
	const r = await getResearchById(researchId)
	if (!r) return null
	const [sources, steps] = await Promise.all([
		listSourcesForResearch(researchId),
		listStepsForResearch(researchId),
	])
	return { research: r, sources, steps }
}
