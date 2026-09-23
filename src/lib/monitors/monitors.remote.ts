import { command, query } from '$app/server'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { withUserInputErrors } from '$lib/server/user-input-error'
import {
	monitorActionConfigSchema,
	monitorActionSchema,
	monitorConditionSchema,
	MONITOR_DEFAULT_INTERVAL_SECONDS,
	MONITOR_DEFAULT_MAX_CHECKS,
	MONITOR_HARD_MAX_CHECKS,
	MONITOR_MAX_DEADLINE_DAYS,
	MONITOR_MAX_INTERVAL_SECONDS,
	MONITOR_MIN_INTERVAL_SECONDS,
} from './condition'
import {
	cancelMonitor,
	createMonitor,
	extendMonitor,
	getMonitorForUser,
	listMonitorsForUser,
	setMonitorPaused,
	updateMonitorSettings,
} from './monitors.server'

/**
 * #33 — the `/monitors` page's data surface. Every mutation is scoped to the request user;
 * there is no admin-wide view, because a monitor is a standing instruction someone left
 * behind and only its owner should be able to cancel or extend it.
 */

const createSchema = z.object({
	name: z.string().trim().min(1).max(200),
	agentId: z.string().uuid().nullable().optional(),
	condition: monitorConditionSchema,
	action: monitorActionSchema,
	actionConfig: monitorActionConfigSchema.optional(),
	intervalSeconds: z.number().int().min(MONITOR_MIN_INTERVAL_SECONDS).max(MONITOR_MAX_INTERVAL_SECONDS).optional(),
	/** Days from now. Omitted or over the ceiling both resolve to the 30-day maximum. */
	deadlineDays: z.number().min(0.01).max(MONITOR_MAX_DEADLINE_DAYS).optional(),
	maxChecks: z.number().int().min(1).max(MONITOR_HARD_MAX_CHECKS).optional(),
	oneShot: z.boolean().optional(),
})

const idSchema = z.object({ id: z.string().uuid() })

export const listMonitorsQuery = query(
	z.object({ openOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }).default({}),
	async (input) => {
		const user = requireAuthenticatedRequestUser()
		const rows = await listMonitorsForUser(user.id, { openOnly: input.openOnly, limit: input.limit })
		return {
			monitors: rows,
			limits: {
				maxDeadlineDays: MONITOR_MAX_DEADLINE_DAYS,
				minIntervalSeconds: MONITOR_MIN_INTERVAL_SECONDS,
				maxIntervalSeconds: MONITOR_MAX_INTERVAL_SECONDS,
				defaultIntervalSeconds: MONITOR_DEFAULT_INTERVAL_SECONDS,
				defaultMaxChecks: MONITOR_DEFAULT_MAX_CHECKS,
				hardMaxChecks: MONITOR_HARD_MAX_CHECKS,
			},
		}
	},
)

export const createMonitorCommand = command(createSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const now = new Date()
	return withUserInputErrors(() =>
		createMonitor(
			{
				userId: user.id,
				agentId: input.agentId ?? null,
				name: input.name,
				condition: input.condition,
				action: input.action,
				actionConfig: input.actionConfig,
				intervalSeconds: input.intervalSeconds,
				deadlineAt: input.deadlineDays ? new Date(now.getTime() + input.deadlineDays * 24 * 60 * 60 * 1000) : null,
				maxChecks: input.maxChecks,
				oneShot: input.oneShot,
			},
			now,
		),
	)
})

export const cancelMonitorCommand = command(idSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	return cancelMonitor(user.id, id)
})

export const setMonitorPausedCommand = command(
	z.object({ id: z.string().uuid(), paused: z.boolean() }),
	async ({ id, paused }) => {
		const user = requireAuthenticatedRequestUser()
		return setMonitorPaused(user.id, id, paused)
	},
)

export const extendMonitorCommand = command(
	z.object({
		id: z.string().uuid(),
		additionalDays: z.number().min(0).max(MONITOR_MAX_DEADLINE_DAYS).optional(),
		additionalChecks: z.number().int().min(0).max(MONITOR_HARD_MAX_CHECKS).optional(),
	}),
	async ({ id, additionalDays, additionalChecks }) => {
		const user = requireAuthenticatedRequestUser()
		return withUserInputErrors(() => extendMonitor(user.id, id, { additionalDays, additionalChecks }))
	},
)

export const updateMonitorCommand = command(
	z.object({
		id: z.string().uuid(),
		name: z.string().trim().min(1).max(200).optional(),
		intervalSeconds: z.number().int().min(MONITOR_MIN_INTERVAL_SECONDS).max(MONITOR_MAX_INTERVAL_SECONDS).optional(),
		maxChecks: z.number().int().min(1).max(MONITOR_HARD_MAX_CHECKS).optional(),
		oneShot: z.boolean().optional(),
		actionConfig: monitorActionConfigSchema.optional(),
	}),
	async ({ id, ...patch }) => {
		const user = requireAuthenticatedRequestUser()
		return withUserInputErrors(() => updateMonitorSettings(user.id, id, patch))
	},
)

/**
 * "Check now" — enqueue a check instead of running one inline, so the page never waits on a
 * web fetch or a model call and the run shows up in the job queue like every other check.
 */
export const checkMonitorNowCommand = command(idSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	const monitor = await getMonitorForUser(user.id, id)
	if (!monitor) error(404, 'Monitor not found')
	if (monitor.status !== 'active') error(409, `Monitor is ${monitor.status} — only an active monitor can be checked`)
	const { enqueueJob } = await import('$lib/jobs/jobs.server')
	const job = await enqueueJob({
		type: 'monitor_check',
		queue: 'default',
		priority: 120,
		dedupeKey: `monitor_manual:${id}:${Date.now()}`,
		payload: { monitorId: id },
		userId: user.id,
	})
	return { jobId: job.id }
})
