import { db } from '$lib/db.server'
import { activityEvents } from '$lib/activity/activity.schema'

type ActivityEventType =
	| 'task_created'
	| 'task_status_changed'
	| 'agent_action'
	| 'chat_started'
	| 'review_action'
	| 'skill_created'
	| 'project_created'
	| 'project_status_changed'
	| 'goal_created'
	| 'strategy_submitted'
	| 'strategy_approved'
	| 'strategy_rejected'

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
