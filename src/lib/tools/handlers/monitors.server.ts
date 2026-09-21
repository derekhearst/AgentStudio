/**
 * #33 — monitor tool handlers, so an agent can leave a watcher behind mid-conversation
 * ("keep an eye on this and tell me when it changes") instead of the user having to open a
 * form afterwards.
 *
 * The handlers are thin: every cap, every clamp and every validation lives in
 * `$lib/monitors`, so a monitor created by an agent is subject to exactly the same rules as
 * one created from `/monitors`. The only thing added here is shaping the response so the
 * model sees when the monitor expires — a monitor it forgets to mention is a monitor the
 * user does not know is running.
 */

import { toolSchemas } from '../tool-schemas'
import { describeCondition, monitorConditionSchema } from '$lib/monitors/condition'
import {
	cancelMonitor,
	createMonitor,
	extendMonitor,
	listMonitorsForUser,
} from '$lib/monitors/monitors.server'
import type { MonitorRow } from '$lib/monitors/monitors.schema'
import type { ToolHandler } from '../handler-types'

/** Compact row shape for the model — the full observation blob would swamp its context. */
function summarize(row: MonitorRow) {
	let watching: string
	try {
		watching = describeCondition(monitorConditionSchema.parse(row.condition))
	} catch {
		watching = '(condition no longer parses)'
	}
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		watching,
		action: row.action,
		intervalSeconds: row.intervalSeconds,
		deadlineAt: row.deadlineAt.toISOString(),
		checksUsed: row.checkCount,
		maxChecks: row.maxChecks,
		oneShot: row.oneShot,
		conditionCurrentlyMet: row.conditionMet,
		lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
		nextCheckAt: row.nextCheckAt.toISOString(),
		lastObserved: row.lastObservation
			? { note: row.lastObservation.note ?? null, value: row.lastObservation.value.slice(0, 500), observedAt: row.lastObservation.observedAt }
			: null,
		fireCount: row.fireCount,
		lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
		lastError: row.lastError,
	}
}

export const monitorHandlers: Record<string, ToolHandler> = {
	create_monitor: async (call, { userId, startedAt }) => {
		const input = toolSchemas.create_monitor.parse(call.arguments)
		const now = new Date()
		const created = await createMonitor(
			{
				userId,
				name: input.name,
				condition: input.condition,
				action: input.action,
				actionConfig: input.actionConfig,
				intervalSeconds: input.intervalSeconds,
				deadlineAt: input.deadlineDays
					? new Date(now.getTime() + input.deadlineDays * 24 * 60 * 60 * 1000)
					: null,
				maxChecks: input.maxChecks,
				oneShot: input.oneShot,
			},
			now,
		)
		return {
			success: true,
			tool: call.name,
			input,
			result: {
				...summarize(created),
				// Stated explicitly because the model should repeat it back to the user.
				expiresAt: created.deadlineAt.toISOString(),
				note: `Monitor is active. It expires at ${created.deadlineAt.toISOString()} or after ${created.maxChecks} checks, whichever comes first, and must be extended explicitly to outlive that.`,
			},
			executionMs: Date.now() - startedAt,
		}
	},

	list_monitors: async (call, { userId, startedAt }) => {
		const input = toolSchemas.list_monitors.parse(call.arguments)
		const rows = await listMonitorsForUser(userId, { openOnly: input.openOnly })
		return {
			success: true,
			tool: call.name,
			input,
			result: rows.map(summarize),
			executionMs: Date.now() - startedAt,
		}
	},

	cancel_monitor: async (call, { userId, startedAt }) => {
		const input = toolSchemas.cancel_monitor.parse(call.arguments)
		const canceled = await cancelMonitor(userId, input.monitorId)
		if (!canceled) {
			return {
				success: false,
				tool: call.name,
				error: 'Monitor not found',
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: { id: canceled.id, status: canceled.status },
			executionMs: Date.now() - startedAt,
		}
	},

	extend_monitor: async (call, { userId, startedAt }) => {
		const input = toolSchemas.extend_monitor.parse(call.arguments)
		const extended = await extendMonitor(userId, input.monitorId, {
			additionalDays: input.additionalDays,
			additionalChecks: input.additionalChecks,
		})
		if (!extended) {
			return {
				success: false,
				tool: call.name,
				error: 'Monitor not found',
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: summarize(extended),
			executionMs: Date.now() - startedAt,
		}
	},
}
