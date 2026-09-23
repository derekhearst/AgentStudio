import { db } from '$lib/db.server'
import { activityEvents } from '$lib/activity/activity.schema'
import { logger } from '$lib/observability/logger'

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

/**
 * Fire-and-forget `emitActivity`, for callers that must neither wait on the activity feed nor
 * fail because of it. A bare `void emitActivity(...)` leaves a rejected insert unhandled,
 * and under Bun an unhandled rejection exits the process: a dropped database connection while
 * a chat started would have taken the whole server down over a feed row.
 */
export function emitActivityInBackground(...args: Parameters<typeof emitActivity>): void {
	emitActivity(...args).catch((err) => {
		logger.warn('[activity] emit failed (non-fatal)', {
			type: args[0],
			error: err instanceof Error ? err.message : String(err),
		})
	})
}
