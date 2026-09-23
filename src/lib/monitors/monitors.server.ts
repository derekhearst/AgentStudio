import { and, asc, desc, eq, gt, lte, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { monitors, type MonitorRow, type MonitorStatus } from './monitors.schema'
import { automations } from '$lib/automations/automation.schema'
import {
	clampDeadline,
	clampInterval,
	clampMaxChecks,
	monitorActionConfigSchema,
	monitorActionSchema,
	monitorConditionSchema,
	validateActionConfig,
	MONITOR_DEFAULT_INTERVAL_SECONDS,
	MONITOR_MAX_DEADLINE_DAYS,
	type MonitorAction,
	type MonitorActionConfig,
	type MonitorCondition,
} from './condition'

/**
 * #33 — monitor CRUD + lifecycle. The pure rules live in `condition.ts`; this module is the
 * persistence around them.
 *
 * Every write funnels through `createMonitor` / `updateMonitorSettings` / `extendMonitor` so
 * the caps are applied in exactly one place. A caller cannot reach into the table and set a
 * 400-day deadline, because nothing else writes `deadlineAt`.
 */

/** Ceiling on simultaneously-active monitors per user. Fifty watchers is already a lot. */
export const MONITOR_MAX_ACTIVE_PER_USER = 50

export type CreateMonitorInput = {
	userId: string
	agentId?: string | null
	name: string
	condition: MonitorCondition
	action: MonitorAction
	actionConfig?: MonitorActionConfig
	intervalSeconds?: number
	/** Omit for the maximum window. There is no "forever". */
	deadlineAt?: Date | string | null
	maxChecks?: number
	oneShot?: boolean
}

/**
 * The automation a `run_automation` monitor may fire: one that exists and belongs to the
 * monitor's owner. Null for anything else — a foreign id and a missing one look the same, so
 * the check cannot be used to learn which ids exist.
 *
 * The action config used to be validated as "a UUID" and nothing more, and the job handler
 * looks an automation up by id alone and runs it as ITS owner — so a monitor could fire
 * someone else's automation, on their budget. Checked when the monitor is written and again
 * when it fires, because the automation can change hands or disappear in between.
 *
 * `enabled` rides along for the fire-time check: a monitor may point at an automation that is
 * switched off (saving it is fine — it may be switched on later), but must not run one.
 */
export async function findOwnedAutomation(
	userId: string,
	automationId: string,
): Promise<{ id: string; enabled: boolean } | null> {
	const [row] = await db
		.select({ id: automations.id, enabled: automations.enabled })
		.from(automations)
		.where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
		.limit(1)
	return row ?? null
}

async function assertActionTargetsOwned(userId: string, action: MonitorAction, config: MonitorActionConfig) {
	if (action !== 'run_automation' || !config.automationId) return
	if (!(await findOwnedAutomation(userId, config.automationId))) {
		throw new Error(`automation ${config.automationId} not found — run_automation needs one of your own automations`)
	}
}

export async function createMonitor(input: CreateMonitorInput, now = new Date()): Promise<MonitorRow> {
	const condition = monitorConditionSchema.parse(input.condition)
	const action = monitorActionSchema.parse(input.action)
	const actionConfig = monitorActionConfigSchema.parse(input.actionConfig ?? {})
	const configError = validateActionConfig(action, actionConfig)
	if (configError) throw new Error(configError)
	await assertActionTargetsOwned(input.userId, action, actionConfig)

	const name = input.name.trim()
	if (name.length === 0) throw new Error('monitor name is required')

	const [{ activeCount }] = await db
		.select({ activeCount: drizzleSql<number>`count(*)::int` })
		.from(monitors)
		.where(and(eq(monitors.userId, input.userId), drizzleSql`${monitors.status} in ('active', 'paused')`))
	if (Number(activeCount) >= MONITOR_MAX_ACTIVE_PER_USER) {
		throw new Error(
			`monitor limit reached — ${MONITOR_MAX_ACTIVE_PER_USER} active monitors already exist. Cancel one first.`,
		)
	}

	const intervalSeconds = clampInterval(input.intervalSeconds ?? MONITOR_DEFAULT_INTERVAL_SECONDS)
	const deadlineAt = clampDeadline(input.deadlineAt ?? null, now, intervalSeconds)

	const [row] = await db
		.insert(monitors)
		.values({
			userId: input.userId,
			agentId: input.agentId ?? null,
			name: name.slice(0, 200),
			status: 'active',
			conditionKind: condition.kind,
			condition,
			action,
			actionConfig,
			intervalSeconds,
			deadlineAt,
			maxChecks: clampMaxChecks(input.maxChecks),
			// Check straight away. For a `changed` condition the first check is the baseline,
			// so the sooner it lands the sooner the monitor is actually armed.
			nextCheckAt: now,
			oneShot: input.oneShot ?? true,
		})
		.returning()
	return row
}

// ─────────── Reads ───────────

export async function getMonitorById(monitorId: string): Promise<MonitorRow | null> {
	const [row] = await db.select().from(monitors).where(eq(monitors.id, monitorId)).limit(1)
	return row ?? null
}

export async function getMonitorForUser(userId: string, monitorId: string): Promise<MonitorRow | null> {
	const [row] = await db
		.select()
		.from(monitors)
		.where(and(eq(monitors.id, monitorId), eq(monitors.userId, userId)))
		.limit(1)
	return row ?? null
}

export type ListMonitorsFilters = {
	status?: MonitorStatus | MonitorStatus[]
	/** Convenience for the UI's default view: active + paused only. */
	openOnly?: boolean
	limit?: number
}

export async function listMonitorsForUser(userId: string, filters: ListMonitorsFilters = {}): Promise<MonitorRow[]> {
	const where = [eq(monitors.userId, userId)]
	if (filters.openOnly) {
		where.push(drizzleSql`${monitors.status} in ('active', 'paused')`)
	} else if (filters.status) {
		const statuses = Array.isArray(filters.status) ? filters.status : [filters.status]
		where.push(
			drizzleSql`${monitors.status} in (${drizzleSql.join(
				statuses.map((s) => drizzleSql`${s}`),
				drizzleSql`, `,
			)})`,
		)
	}
	return db
		.select()
		.from(monitors)
		.where(and(...where))
		// Open monitors first, then most recently touched.
		.orderBy(drizzleSql`case when ${monitors.status} = 'active' then 0 when ${monitors.status} = 'paused' then 1 else 2 end`, desc(monitors.updatedAt))
		.limit(Math.min(500, Math.max(1, filters.limit ?? 100)))
}

/**
 * The dispatcher's query: active monitors whose next check is due and whose deadline has not
 * passed. Ordered oldest-due-first so a backlog drains fairly.
 */
export async function listDueMonitors(now = new Date(), limit = 50): Promise<MonitorRow[]> {
	return db
		.select()
		.from(monitors)
		// `gt` rather than a raw template: postgres-js refuses a JS Date bound directly into
		// a sql`` fragment, while the column's own mapper converts it correctly.
		.where(and(eq(monitors.status, 'active'), lte(monitors.nextCheckAt, now), gt(monitors.deadlineAt, now)))
		.orderBy(asc(monitors.nextCheckAt))
		.limit(limit)
}

/**
 * Claim a due monitor for one check by pushing its `nextCheckAt` a full interval forward,
 * atomically and only if it is still due. Returns null when another dispatcher got there
 * first (or the monitor stopped being eligible).
 *
 * This is what keeps a slow check from being double-dispatched: the monitor is no longer due
 * the moment it is claimed, so the next minute's tick skips it even if the job it produced is
 * still running. A check that never completes costs one interval of delay, not a pile of
 * concurrent checks racing to write the same latch.
 */
export async function claimMonitorForCheck(monitorId: string, now = new Date()): Promise<MonitorRow | null> {
	const [row] = await db
		.update(monitors)
		.set({
			// `now()` rather than a bound Date: postgres-js will not accept a JS Date as a
			// raw template parameter, and the server clock is the right clock here anyway.
			nextCheckAt: drizzleSql`now() + (${monitors.intervalSeconds} * interval '1 second')`,
			updatedAt: now,
		})
		.where(and(eq(monitors.id, monitorId), eq(monitors.status, 'active'), lte(monitors.nextCheckAt, now)))
		.returning()
	return row ?? null
}

// ─────────── Lifecycle ───────────

/**
 * Retire every monitor whose deadline has passed. Runs on the dispatch tick, so an expired
 * monitor stops being checked within a minute of its deadline regardless of its interval —
 * a 24-hour-interval monitor does not linger for a day past its expiry.
 */
export async function expireOverdueMonitors(now = new Date()): Promise<number> {
	const rows = await db
		.update(monitors)
		.set({ status: 'expired', updatedAt: now })
		.where(and(drizzleSql`${monitors.status} in ('active', 'paused')`, lte(monitors.deadlineAt, now)))
		.returning({ id: monitors.id })
	return rows.length
}

export type SetMonitorStatusOptions = { error?: string | null }

export async function setMonitorStatus(
	monitorId: string,
	status: MonitorStatus,
	options: SetMonitorStatusOptions = {},
): Promise<MonitorRow | null> {
	const [row] = await db
		.update(monitors)
		.set({
			status,
			...(options.error !== undefined ? { lastError: options.error } : {}),
			updatedAt: new Date(),
		})
		.where(eq(monitors.id, monitorId))
		.returning()
	return row ?? null
}

export async function cancelMonitor(userId: string, monitorId: string): Promise<MonitorRow | null> {
	const [row] = await db
		.update(monitors)
		.set({ status: 'canceled', updatedAt: new Date() })
		.where(and(eq(monitors.id, monitorId), eq(monitors.userId, userId)))
		.returning()
	return row ?? null
}

/** Pause/resume. A paused monitor keeps its deadline — pausing buys no extra lifetime. */
export async function setMonitorPaused(userId: string, monitorId: string, paused: boolean, now = new Date()): Promise<MonitorRow | null> {
	const existing = await getMonitorForUser(userId, monitorId)
	if (!existing) return null
	if (paused && existing.status !== 'active') return existing
	if (!paused && existing.status !== 'paused') return existing
	const [row] = await db
		.update(monitors)
		.set({
			status: paused ? 'paused' : 'active',
			// Resuming re-arms on the next tick rather than replaying the missed window.
			...(paused ? {} : { nextCheckAt: now }),
			updatedAt: now,
		})
		.where(and(eq(monitors.id, monitorId), eq(monitors.userId, userId)))
		.returning()
	return row ?? null
}

export type ExtendMonitorInput = {
	/** Days to push the deadline out from now. Re-capped at the 30-day ceiling. */
	additionalDays?: number
	/** Extra checks added to the budget. Re-capped at the hard ceiling. */
	additionalChecks?: number
}

/**
 * The explicit extension the issue asks for. Deliberately not "renew automatically": a
 * monitor that has expired or exhausted its budget only comes back because a human (or an
 * agent acting on a human's instruction) said so, and the new window is capped from *now*,
 * not from the old deadline — so repeated extensions cannot compound past 30 days at a time.
 */
export async function extendMonitor(
	userId: string,
	monitorId: string,
	input: ExtendMonitorInput,
	now = new Date(),
): Promise<MonitorRow | null> {
	const existing = await getMonitorForUser(userId, monitorId)
	if (!existing) return null
	if (existing.status === 'canceled') throw new Error('a canceled monitor cannot be extended — create a new one')

	const days = Math.min(MONITOR_MAX_DEADLINE_DAYS, Math.max(0, Math.floor(input.additionalDays ?? 0)))
	const requested = days > 0 ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000) : existing.deadlineAt
	const deadlineAt = clampDeadline(requested, now, existing.intervalSeconds)

	const maxChecks = clampMaxChecks(existing.maxChecks + Math.max(0, Math.floor(input.additionalChecks ?? 0)))
	// An extension is only meaningful if the monitor also has budget left to spend.
	const budgetLeft = maxChecks > existing.checkCount
	// Only a monitor that had STOPPED is revived. Extending an active or paused one adjusts
	// its caps and leaves its schedule alone — an extension is not a "check now".
	const revive =
		deadlineAt.getTime() > now.getTime() &&
		budgetLeft &&
		(existing.status === 'expired' || existing.status === 'exhausted' || existing.status === 'failed')
	const [row] = await db
		.update(monitors)
		.set({
			deadlineAt,
			maxChecks,
			...(revive
				? { status: 'active' as MonitorStatus, nextCheckAt: now, lastError: null, consecutiveErrors: 0 }
				: {}),
			updatedAt: now,
		})
		.where(and(eq(monitors.id, monitorId), eq(monitors.userId, userId)))
		.returning()
	return row ?? null
}

/** Editable settings. The condition itself is immutable — a different condition is a different monitor. */
export type UpdateMonitorSettingsInput = {
	name?: string
	intervalSeconds?: number
	maxChecks?: number
	oneShot?: boolean
	actionConfig?: MonitorActionConfig
}

export async function updateMonitorSettings(
	userId: string,
	monitorId: string,
	input: UpdateMonitorSettingsInput,
	now = new Date(),
): Promise<MonitorRow | null> {
	const existing = await getMonitorForUser(userId, monitorId)
	if (!existing) return null
	const patch: Partial<typeof monitors.$inferInsert> = { updatedAt: now }
	if (input.name !== undefined) {
		const name = input.name.trim()
		if (name.length === 0) throw new Error('monitor name is required')
		patch.name = name.slice(0, 200)
	}
	if (input.intervalSeconds !== undefined) patch.intervalSeconds = clampInterval(input.intervalSeconds)
	if (input.maxChecks !== undefined) patch.maxChecks = clampMaxChecks(input.maxChecks)
	if (input.oneShot !== undefined) patch.oneShot = input.oneShot
	if (input.actionConfig !== undefined) {
		const actionConfig = monitorActionConfigSchema.parse(input.actionConfig)
		const configError = validateActionConfig(existing.action, actionConfig)
		if (configError) throw new Error(configError)
		await assertActionTargetsOwned(userId, existing.action, actionConfig)
		patch.actionConfig = actionConfig
	}
	const [row] = await db
		.update(monitors)
		.set(patch)
		.where(and(eq(monitors.id, monitorId), eq(monitors.userId, userId)))
		.returning()
	return row ?? null
}

/** Milliseconds of remaining lifetime, floored at 0. Used by the UI + the tool's response. */
export function remainingLifetimeMs(row: Pick<MonitorRow, 'deadlineAt'>, now = new Date()): number {
	return Math.max(0, new Date(row.deadlineAt).getTime() - now.getTime())
}
