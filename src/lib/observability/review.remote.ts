import { command, query } from '$app/server'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import {
	assignReviewItem,
	getReviewItemById,
	listReviewItems,
	listOpenReviewItems,
	resolveReviewItem,
	reviewInboxRollup,
} from './review.server'
import { reviewItemListSchema } from './review-filters'
import { getRunTraceByRunId, listRecentFailures } from './traces.server'
import { listMetricSnapshotsWithSeries } from './metrics.server'

/**
 * Wave 5 #20 phase 1 — Review Inbox SvelteKit remote surface.
 *
 * Authenticated-only access — review items can carry sensitive payloads (tool args,
 * evaluator findings, policy override requests). Since the app moved to a single-user
 * model there are no roles left, so the `adminOnly` flag these queries return is always
 * `false`; it is kept only so the response shape stays stable for existing consumers.
 */

export const listReviewItemsQuery = query(reviewItemListSchema, async (input) => {
	requireAuthenticatedRequestUser()
	const items = input.openOnly
		? await listOpenReviewItems(input.limit)
		: await listReviewItems({
				status: input.status,
				type: input.type,
				severity: input.severity,
				limit: input.limit,
			})
	const rollup = await reviewInboxRollup()
	return { items, rollup, adminOnly: false as const }
})

export const getReviewItemQuery = query(z.string().uuid(), async (itemId) => {
	requireAuthenticatedRequestUser()
	return getReviewItemById(itemId)
})

const resolveSchema = z.object({
	itemId: z.string().uuid(),
	action: z.string().trim().min(1).max(120),
	note: z.string().trim().max(2000).optional(),
	finalStatus: z.enum(['resolved', 'dismissed']).optional(),
})

export const resolveReviewItemCommand = command(resolveSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	// A paused run's prompt is answered, not resolved. Closing only the review row used to
	// leave the run waiting until it timed out, whatever the button said.
	const item = await getReviewItemById(input.itemId)
	if (item?.type === 'approval_request') {
		// "A dismissed approval request means the tool call is denied."
		if (input.finalStatus !== 'dismissed') error(400, 'Approve or deny this tool call instead')
		const { decideApprovalFromReview } = await import('$lib/runs/review-decisions.server')
		await decideApprovalFromReview({
			itemId: input.itemId,
			userId: user.id,
			approved: false,
			note: input.note ?? 'Dismissed from the review inbox',
		})
		return getReviewItemById(input.itemId)
	}
	if (item?.type === 'user_question') error(400, 'Answer the question instead, here or in the chat')
	return resolveReviewItem({
		itemId: input.itemId,
		resolvedBy: user.id,
		action: input.action,
		note: input.note,
		finalStatus: input.finalStatus,
	})
})

const decideApprovalSchema = z.object({
	itemId: z.string().uuid(),
	approved: z.boolean(),
	note: z.string().trim().max(2000).optional(),
})

/** Approve or deny, from /review, the tool call a paused run is waiting on. */
export const decideApprovalReviewItemCommand = command(decideApprovalSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const { decideApprovalFromReview } = await import('$lib/runs/review-decisions.server')
	return decideApprovalFromReview({ ...input, userId: user.id })
})

const answerQuestionSchema = z.object({
	itemId: z.string().uuid(),
	// Keyed by question header, as the chat's answer card sends them.
	answers: z
		.record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(4000))
		.refine((answers) => Object.keys(answers).length > 0, 'Answer at least one question'),
})

/** Answer, from /review, the questions a paused run asked with ask_user. */
export const answerQuestionReviewItemCommand = command(answerQuestionSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const { answerQuestionFromReview } = await import('$lib/runs/review-decisions.server')
	return answerQuestionFromReview({ ...input, userId: user.id })
})

const assignSchema = z.object({
	itemId: z.string().uuid(),
	userId: z.string().uuid().nullable(),
})

export const assignReviewItemCommand = command(assignSchema, async (input) => {
	requireAuthenticatedRequestUser()
	return assignReviewItem(input.itemId, input.userId)
})

/**
 * Wave 5 #20 phase 3 — fetch the run-trace timeline for the trace viewer.
 *
 * Admin-only (traces can carry tool args + payload data). Returns null when no trace exists
 * for the given runId. The trace itself is a jsonb array of span objects — the viewer page
 * decides how to render each kind.
 */
export const getRunTraceQuery = query(z.string().uuid(), async (runId) => {
	requireAuthenticatedRequestUser()
	const row = await getRunTraceByRunId(runId)
	return { trace: row, adminOnly: false as const }
})

/**
 * Wave 5 #20 phase 4 — operational metrics snapshot + 24h timeseries for the health dashboard.
 *
 * Admin-only. Returns one entry per (metric, dimension) pair with the latest value plus the
 * full 24h series so the page can render a sparkline next to each row without an N+1
 * round-trip. Inbox rollup is bundled so the page renders in one shot.
 */
export const getOperationalSnapshotQuery = query(async () => {
	requireAuthenticatedRequestUser()
	const [entries, rollup] = await Promise.all([listMetricSnapshotsWithSeries(24), reviewInboxRollup()])
	return { entries, rollup, adminOnly: false as const }
})

/**
 * Recent run + tool failures for the consolidated /review dashboard: one row per run that
 * ended in `failed` state (from `chat_runs`), plus one per `success=false` tool-call span
 * (from `run_traces`). Cap small (<=50) — for full history, drill into the run pages.
 */
const recentFailuresSchema = z
	.object({
		hours: z.number().int().min(1).max(168).default(24),
		limit: z.number().int().min(1).max(50).default(20),
	})
	.default(() => ({ hours: 24, limit: 20 }))

export const listRecentFailuresQuery = query(recentFailuresSchema, async (input) => {
	requireAuthenticatedRequestUser()
	const failures = await listRecentFailures(input.hours, input.limit)
	return { failures, adminOnly: false as const }
})
