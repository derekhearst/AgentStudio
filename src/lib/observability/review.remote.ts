import { command, query } from '$app/server'
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
import { getRunTraceByRunId } from './traces.server'
import { listMetricSnapshotsWithSeries } from './metrics.server'

/**
 * Wave 5 #20 phase 1 — Review Inbox SvelteKit remote surface.
 *
 * Admin-only access — review items can carry sensitive payloads (tool args, evaluator
 * findings, policy override requests). Non-admins get an empty list + an `adminOnly: true`
 * flag so the UI can render a friendly access-gate.
 */

const REVIEW_ITEM_TYPES = [
	'approval_request',
	'user_question',
	'evaluation_failure',
	'job_failure',
	'job_stuck',
	'hook_failure',
	'artifact_conflict',
	'memory_conflict',
	'policy_override_request',
	'pull_request_ready',
	'automation_summary',
] as const

const REVIEW_ITEM_STATUSES = ['open', 'in_progress', 'resolved', 'dismissed'] as const

const listSchema = z
	.object({
		status: z.enum(REVIEW_ITEM_STATUSES).optional(),
		type: z.enum(REVIEW_ITEM_TYPES).optional(),
		severity: z.enum(['info', 'warning', 'critical']).optional(),
		openOnly: z.boolean().optional(),
		limit: z.number().int().min(1).max(500).optional(),
	})
	.default({})

export const listReviewItemsQuery = query(listSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') {
		return { items: [], rollup: [], adminOnly: true as const }
	}
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
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') return null
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
	if (user.role !== 'admin') throw new Error('Not authorized')
	return resolveReviewItem({
		itemId: input.itemId,
		resolvedBy: user.id,
		action: input.action,
		note: input.note,
		finalStatus: input.finalStatus,
	})
})

const assignSchema = z.object({
	itemId: z.string().uuid(),
	userId: z.string().uuid().nullable(),
})

export const assignReviewItemCommand = command(assignSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') throw new Error('Not authorized')
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
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') return { trace: null, adminOnly: true as const }
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
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') return { entries: [], rollup: [], adminOnly: true as const }
	const [entries, rollup] = await Promise.all([listMetricSnapshotsWithSeries(24), reviewInboxRollup()])
	return { entries, rollup, adminOnly: false as const }
})
