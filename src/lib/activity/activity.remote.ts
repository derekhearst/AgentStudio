import { query } from '$app/server'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { activityEvents } from '$lib/activity/activity.schema'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

const listActivitySchema = z.object({
	type: z
		.enum([
			'task_created',
			'task_status_changed',
			'agent_action',
			'chat_started',
			'review_action',
			'skill_created',
			'project_created',
			'project_status_changed',
			'goal_created',
			'strategy_submitted',
			'strategy_approved',
			'strategy_rejected',
		])
		.optional(),
	limit: z.number().int().min(1).max(200).optional(),
})

// The feed is instance-wide — `activity_events` has no owner column — so the session check
// is the whole of the access rule.
export const listActivity = query(listActivitySchema, async ({ type, limit }) => {
	requireAuthenticatedRequestUser()
	const rows = await db
		.select()
		.from(activityEvents)
		.where(type ? eq(activityEvents.type, type) : undefined)
		.orderBy(desc(activityEvents.createdAt))
		.limit(limit ?? 50)

	return rows
})
