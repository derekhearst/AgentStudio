import { query } from '$app/server'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/server/db'
import { activityEvents } from '$lib/server/db/schema'

const listActivitySchema = z.object({
	type: z
		.enum([
			'task_created',
			'task_status_changed',
			'agent_action',
			'memory_created',
			'dream_cycle',
			'chat_started',
			'review_action',
		])
		.optional(),
	limit: z.number().int().min(1).max(200).optional(),
})

export const listActivity = query(listActivitySchema, async ({ type, limit }) => {
	const rows = await db
		.select()
		.from(activityEvents)
		.where(type ? eq(activityEvents.type, type) : undefined)
		.orderBy(desc(activityEvents.createdAt))
		.limit(limit ?? 50)

	return rows
})
