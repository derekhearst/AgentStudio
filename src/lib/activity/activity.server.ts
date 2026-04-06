import { db } from '$lib/db.server'
import { activityEvents } from '$lib/activity/activity.schema'

type ActivityEventType =
	| 'task_created'
	| 'task_status_changed'
	| 'agent_action'
	| 'memory_created'
	| 'dream_cycle'
	| 'chat_started'
	| 'review_action'
	| 'skill_created'

export async function emitActivity(
	type: ActivityEventType,
	summary: string,
	opts?: { entityId?: string; entityType?: string; metadata?: Record<string, unknown> },
) {
	await db.insert(activityEvents).values({
		type,
		summary,
		entityId: opts?.entityId ?? null,
		entityType: opts?.entityType ?? null,
		metadata: opts?.metadata ?? {},
	})
}
