import { and, asc, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
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

export async function updateResearch(
	researchId: string,
	patch: UpdateResearchInput,
): Promise<ResearchRow | null> {
	const updates: Partial<typeof research.$inferInsert> = { updatedAt: new Date() }
	if (patch.status !== undefined) updates.status = patch.status
	if (patch.plan !== undefined) updates.plan = patch.plan
	if (patch.report !== undefined) updates.report = patch.report
	if (patch.costUsd !== undefined) updates.costUsd = String(patch.costUsd)
	if (patch.tokensUsed !== undefined) updates.tokensUsed = patch.tokensUsed
	if (patch.finishedAt !== undefined) updates.finishedAt = patch.finishedAt
	if (patch.error !== undefined) updates.error = patch.error
	if (patch.jobId !== undefined) updates.jobId = patch.jobId
	const [row] = await db.update(research).set(updates).where(eq(research.id, researchId)).returning()
	return row ?? null
}

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

export async function markSourcesCited(
	researchId: string,
	sourceIds: string[],
): Promise<{ updated: number }> {
	if (sourceIds.length === 0) return { updated: 0 }
	const result = await db
		.update(researchSources)
		.set({ citedInReport: true })
		.where(and(eq(researchSources.researchId, researchId), drizzleSql`${researchSources.id} = ANY(${sourceIds})`))
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
