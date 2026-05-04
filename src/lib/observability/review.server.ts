import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	reviewItems,
	type ReviewItemRow,
	type ReviewItemSeverity,
	type ReviewItemStatus,
	type ReviewItemType,
} from './observability.schema'

/**
 * Wave 5 #20 phase 1 — Review Inbox lifecycle helpers.
 *
 * One-stop module for opening, listing, assigning, and resolving review items. Sources are
 * pluggable: any domain that wants a human in the loop calls `openReviewItem` with the right
 * `type` + payload. The inbox UI reads via `listOpenReviewItems` and resolves via
 * `resolveReviewItem`.
 *
 * Best-effort writes: a thrown DB error never blocks the originating action. The originating
 * write (e.g. evaluator finishing with a `fail` verdict) succeeds even if the review item
 * creation fails.
 */

export type OpenReviewItemInput = {
	type: ReviewItemType
	severity?: ReviewItemSeverity
	summary?: string
	payload?: Record<string, unknown>
	runId?: string | null
	sessionId?: string | null
	taskId?: string | null
	jobId?: string | null
	projectId?: string | null
	artifactId?: string | null
	assignedTo?: string | null
	// When set, the call is idempotent: looks for an open row matching the same `type` +
	// dedupeKey and returns it instead of creating a duplicate. Use for sources that fire
	// repeatedly (job_stuck ticks, evaluator retries, etc.).
	dedupeKey?: string
}

export async function openReviewItem(input: OpenReviewItemInput): Promise<ReviewItemRow | null> {
	try {
		// Dedupe path: when set, only open ONE outstanding row per (type, dedupeKey).
		if (input.dedupeKey) {
			const [existing] = await db
				.select()
				.from(reviewItems)
				.where(
					and(
						eq(reviewItems.type, input.type),
						drizzleSql`${reviewItems.payload}->>'dedupeKey' = ${input.dedupeKey}`,
						drizzleSql`${reviewItems.status} in ('open', 'in_progress')`,
					),
				)
				.limit(1)
			if (existing) return existing
		}

		const payload = input.dedupeKey
			? { ...(input.payload ?? {}), dedupeKey: input.dedupeKey }
			: (input.payload ?? {})

		const [row] = await db
			.insert(reviewItems)
			.values({
				type: input.type,
				severity: input.severity ?? 'warning',
				summary: input.summary ?? null,
				payload,
				runId: input.runId ?? null,
				sessionId: input.sessionId ?? null,
				taskId: input.taskId ?? null,
				jobId: input.jobId ?? null,
				projectId: input.projectId ?? null,
				artifactId: input.artifactId ?? null,
				assignedTo: input.assignedTo ?? null,
			})
			.returning()
		return row
	} catch (err) {
		console.warn('[review] openReviewItem failed (non-fatal)', err)
		return null
	}
}

export type ListReviewItemsFilters = {
	status?: ReviewItemStatus | ReviewItemStatus[]
	type?: ReviewItemType
	severity?: ReviewItemSeverity
	assignedTo?: string
	runId?: string
	taskId?: string
	limit?: number
}

export async function listReviewItems(filters: ListReviewItemsFilters = {}): Promise<ReviewItemRow[]> {
	const where = []
	if (filters.status) {
		const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
		where.push(
			drizzleSql`${reviewItems.status} in (${drizzleSql.join(statuses.map((s) => drizzleSql`${s}`), drizzleSql`, `)})`,
		)
	}
	if (filters.type) where.push(eq(reviewItems.type, filters.type))
	if (filters.severity) where.push(eq(reviewItems.severity, filters.severity))
	if (filters.assignedTo) where.push(eq(reviewItems.assignedTo, filters.assignedTo))
	if (filters.runId) where.push(eq(reviewItems.runId, filters.runId))
	if (filters.taskId) where.push(eq(reviewItems.taskId, filters.taskId))

	return db
		.select()
		.from(reviewItems)
		.where(where.length > 0 ? and(...where) : undefined)
		.orderBy(desc(reviewItems.createdAt))
		.limit(filters.limit ?? 200)
}

/** Default open-queue view: open + in_progress items ordered by severity desc + age. */
export async function listOpenReviewItems(limit = 200): Promise<ReviewItemRow[]> {
	return db
		.select()
		.from(reviewItems)
		.where(drizzleSql`${reviewItems.status} in ('open', 'in_progress')`)
		.orderBy(
			drizzleSql`case ${reviewItems.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`,
			desc(reviewItems.createdAt),
		)
		.limit(limit)
}

export async function getReviewItemById(itemId: string): Promise<ReviewItemRow | null> {
	const [row] = await db.select().from(reviewItems).where(eq(reviewItems.id, itemId)).limit(1)
	return row ?? null
}

export type ResolveReviewItemInput = {
	itemId: string
	resolvedBy: string
	action: string
	note?: string
	finalStatus?: ReviewItemStatus // default 'resolved'; pass 'dismissed' for skip-without-action.
}

export async function resolveReviewItem(input: ResolveReviewItemInput): Promise<ReviewItemRow | null> {
	const [row] = await db
		.update(reviewItems)
		.set({
			status: input.finalStatus ?? 'resolved',
			resolvedBy: input.resolvedBy,
			resolution: { action: input.action, note: input.note },
			resolvedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(reviewItems.id, input.itemId))
		.returning()
	return row ?? null
}

export async function assignReviewItem(itemId: string, userId: string | null): Promise<ReviewItemRow | null> {
	const [row] = await db
		.update(reviewItems)
		.set({ assignedTo: userId, updatedAt: new Date() })
		.where(eq(reviewItems.id, itemId))
		.returning()
	return row ?? null
}

/**
 * Per-type rollup over the last 24h for the inbox header (open vs. resolved counts).
 * Returns one row per (type, status) pair so the dashboard can render a small grid.
 */
export async function reviewInboxRollup(): Promise<
	Array<{ type: string; status: string; count: number }>
> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
	const rows = await db
		.select({
			type: reviewItems.type,
			status: reviewItems.status,
			count: drizzleSql<number>`count(*)::int`,
		})
		.from(reviewItems)
		.where(drizzleSql`${reviewItems.createdAt} >= ${since}`)
		.groupBy(reviewItems.type, reviewItems.status)
	return rows.map((r) => ({ type: r.type as string, status: r.status as string, count: Number(r.count) }))
}
