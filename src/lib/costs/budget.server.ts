import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { budgetAlerts, budgetLimits, llmUsage, toolUsage } from '$lib/costs/usage.schema'
import { appSettings } from '$lib/settings/settings.schema'
import { logger } from '$lib/observability/logger'

export type BudgetPeriod = 'day' | 'week' | 'month' | 'run'
export type BudgetScope = 'global' | 'project' | 'agent' | 'run'
export type BudgetAction = 'block' | 'notify_only'

export type BudgetLimitRow = {
	id: string
	userId: string
	scope: BudgetScope
	scopeId: string | null
	period: BudgetPeriod
	limitUsd: string
	warnUsd: string | null
	action: BudgetAction
	enabled: boolean
}

export type BudgetCheckContext = {
	userId: string
	agentId?: string | null
	runId?: string | null
	/** Optional projection of how much this run is expected to cost. Leave 0 for a pure pre-check. */
	projectedCostUsd?: number
}

export type BudgetCheckResult = {
	allowed: boolean
	blockedBy: BudgetLimitRow | null
	/**
	 * The spend that tripped `blockedBy`, for the alert record. Both callers used to record
	 * the limit itself here, so every block alert claimed spend == limit and hid the overshoot.
	 */
	blockedSpendUsd: number | null
	warnings: Array<{ limit: BudgetLimitRow; spendUsd: number }>
}

function periodStart(period: BudgetPeriod, now = new Date()): Date {
	if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
	if (period === 'week') {
		const d = new Date(now)
		d.setDate(d.getDate() - d.getDay())
		d.setHours(0, 0, 0, 0)
		return d
	}
	if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
	// 'run' uses the run's startedAt; pre-check has no spend yet so treat as now.
	return now
}

/**
 * Compute the spend (in USD) for a (user, scope, scopeId) tuple over the period window.
 * Sums llm_usage + tool_usage costs.
 */
async function spendForLimit(limit: BudgetLimitRow, now: Date): Promise<number> {
	const since = periodStart(limit.period, now)

	// Build the scope predicate. The same logic applies to both ledger tables.
	const llmFilters = [eq(llmUsage.userId, limit.userId), gte(llmUsage.createdAt, since)]
	const toolFilters = [eq(toolUsage.userId, limit.userId), gte(toolUsage.createdAt, since)]
	if (limit.scope === 'agent' && limit.scopeId) {
		llmFilters.push(eq(llmUsage.agentId, limit.scopeId))
		toolFilters.push(eq(toolUsage.agentId, limit.scopeId))
	}
	if (limit.scope === 'run' && limit.scopeId) {
		llmFilters.push(eq(llmUsage.runId, limit.scopeId))
		toolFilters.push(eq(toolUsage.runId, limit.scopeId))
	}
	// Note: 'project' scope reserved for future projects domain (#15); falls through as
	// user-wide today since no project linkage exists on usage rows yet.

	const [llmRow] = await db
		.select({ total: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text` })
		.from(llmUsage)
		.where(and(...llmFilters))
	const [toolRow] = await db
		.select({ total: sql<string>`coalesce(sum(${toolUsage.cost}::numeric), 0)::text` })
		.from(toolUsage)
		.where(and(...toolFilters))

	return parseFloat(llmRow?.total ?? '0') + parseFloat(toolRow?.total ?? '0')
}

// ─────────── Settings → Budget ───────────

/** The Settings limits warn at this share of the limit ("Alerts trigger at 80% and 100%"). */
export const SETTINGS_WARN_FRACTION = 0.8

const SETTINGS_PERIODS = [
	{ period: 'day', key: 'dailyLimit' },
	{ period: 'month', key: 'monthlyLimit' },
] as const

type SettingsBudgetConfig = {
	dailyLimit?: number | null
	monthlyLimit?: number | null
	limitIds?: { day?: string | null; month?: string | null }
}

/** A usable limit, or null. Empty and zero both mean "no limit", as the Settings field and /review read them. */
function settingsLimit(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function sameAmount(stored: string | null, wanted: number): boolean {
	return stored !== null && Math.abs(parseFloat(stored) - wanted) < 0.0000005
}

type SettingsPeriodPlan = {
	period: 'day' | 'month'
	limit: number | null
	row: BudgetLimitRow | null
}

function needsWrite(plan: SettingsPeriodPlan): boolean {
	if (plan.limit === null) return plan.row !== null && plan.row.enabled
	if (!plan.row) return true
	return (
		!plan.row.enabled ||
		!sameAmount(plan.row.limitUsd, plan.limit) ||
		!sameAmount(plan.row.warnUsd, plan.limit * SETTINGS_WARN_FRACTION)
	)
}

type Executor = Pick<typeof db, 'select'>

async function readSettingsBudget(
	executor: Executor,
	userId: string,
	lock: boolean,
): Promise<{ settingsId: string; config: SettingsBudgetConfig; plans: SettingsPeriodPlan[] } | null> {
	const query = executor
		.select({ id: appSettings.id, budgetConfig: appSettings.budgetConfig })
		.from(appSettings)
		.where(eq(appSettings.userId, userId))
		.orderBy(asc(appSettings.createdAt))
		.limit(1)
	const [settings] = lock ? await query.for('update') : await query
	if (!settings) return null

	const config = (settings.budgetConfig ?? {}) as SettingsBudgetConfig
	const ids = [config.limitIds?.day, config.limitIds?.month].filter((id): id is string => typeof id === 'string')
	const rows = ids.length
		? ((await executor
				.select()
				.from(budgetLimits)
				.where(and(eq(budgetLimits.userId, userId), inArray(budgetLimits.id, ids)))) as BudgetLimitRow[])
		: []

	const plans = SETTINGS_PERIODS.map(({ period, key }) => ({
		period,
		limit: settingsLimit(config[key]),
		row: rows.find((row) => row.id === config.limitIds?.[period]) ?? null,
	}))
	return { settingsId: settings.id, config, plans }
}

/**
 * Enforce the daily and monthly limits from Settings → Budget through `budget_limits`.
 *
 * Those two fields were stored in `app_settings.budget_config` and read only by the /review
 * progress bars. The budget gate reads `budget_limits`, which has no page of its own, so a
 * $5 daily limit in Settings blocked nothing and alerted no one.
 *
 * Each Settings limit is now a global `block` row for its period, warning at 80%. The rows
 * are the ones named in `budget_config.limitIds`, so a limit created any other way is never
 * touched. Clearing a limit disables its row rather than deleting it: a row's alert history
 * goes with it when it is deleted, and alerts are an append-only record.
 *
 * Idempotent and cheap when nothing changed — one read of settings and the named rows. It
 * runs when settings are saved and at the top of every budget check, so a limit saved before
 * this existed is enforced from the next check on.
 */
export async function syncSettingsBudgetLimits(userId: string): Promise<void> {
	const current = await readSettingsBudget(db, userId, false)
	if (!current || !current.plans.some(needsWrite)) return

	await db.transaction(async (tx) => {
		// Re-read under the settings row's lock so two concurrent checks cannot both insert.
		const locked = await readSettingsBudget(tx, userId, true)
		if (!locked) return
		const limitIds = { ...(locked.config.limitIds ?? {}) }
		let idsChanged = false

		for (const plan of locked.plans) {
			if (!needsWrite(plan)) continue
			if (plan.limit === null) {
				await tx
					.update(budgetLimits)
					.set({ enabled: false, updatedAt: new Date() })
					.where(eq(budgetLimits.id, plan.row!.id))
				continue
			}
			const values = {
				limitUsd: plan.limit.toFixed(6),
				warnUsd: (plan.limit * SETTINGS_WARN_FRACTION).toFixed(6),
				enabled: true,
			}
			if (plan.row) {
				await tx
					.update(budgetLimits)
					.set({ ...values, updatedAt: new Date() })
					.where(eq(budgetLimits.id, plan.row.id))
			} else {
				const [created] = await tx
					.insert(budgetLimits)
					.values({ userId, scope: 'global', scopeId: null, period: plan.period, action: 'block', ...values })
					.returning({ id: budgetLimits.id })
				limitIds[plan.period] = created.id
				idsChanged = true
			}
		}

		if (idsChanged) {
			await tx
				.update(appSettings)
				.set({ budgetConfig: { dailyLimit: null, monthlyLimit: null, ...locked.config, limitIds } })
				.where(eq(appSettings.id, locked.settingsId))
		}
	})
}

// ─────────── The gate ───────────

/**
 * Check every enabled budget limit applicable to the request context. Returns a verdict the
 * caller (chat stream, automation engine) uses to decide whether to dispatch the run.
 *
 * Block precedence (most-restrictive wins): the FIRST limit whose `action='block'` would be
 * exceeded (current spend + projectedCost > limitUsd) becomes `blockedBy`. Warn thresholds
 * are evaluated independently and accumulate in `warnings`.
 *
 * Best-effort: failures (e.g. malformed scope) are caught and treated as "allowed" so cost
 * tracking is never on the run-blocking critical path unless an explicit `block` cap fires.
 */
export async function checkBudgetLimits(ctx: BudgetCheckContext, now = new Date()): Promise<BudgetCheckResult> {
	// The Settings limits are enforced through budget_limits rows; bring those up to date
	// first. A failure here must not skip the limits that are already stored.
	try {
		await syncSettingsBudgetLimits(ctx.userId)
	} catch (err) {
		logger.warn('[budget] syncing the Settings budget limits failed; checking the stored limits', { err })
	}

	try {
		const rows = (await db
			.select()
			.from(budgetLimits)
			.where(and(eq(budgetLimits.userId, ctx.userId), eq(budgetLimits.enabled, true)))) as BudgetLimitRow[]

		const projection = Math.max(0, ctx.projectedCostUsd ?? 0)
		const result: BudgetCheckResult = { allowed: true, blockedBy: null, blockedSpendUsd: null, warnings: [] }

		// Filter to limits whose scope matches this request's context.
		const applicable = rows.filter((limit) => {
			if (limit.scope === 'global') return true
			if (limit.scope === 'agent') return ctx.agentId != null && limit.scopeId === ctx.agentId
			if (limit.scope === 'run') return ctx.runId != null && limit.scopeId === ctx.runId
			// project scope skipped (no projects domain yet)
			return false
		})

		for (const limit of applicable) {
			const spend = await spendForLimit(limit, now)
			const projected = spend + projection
			const limitNum = parseFloat(limit.limitUsd)
			const warnNum = limit.warnUsd ? parseFloat(limit.warnUsd) : null

			if (warnNum !== null && projected >= warnNum) {
				result.warnings.push({ limit, spendUsd: spend })
			}
			if (limit.action === 'block' && projected > limitNum && !result.blockedBy) {
				result.blockedBy = limit
				result.blockedSpendUsd = spend
				result.allowed = false
			}
		}

		return result
	} catch (err) {
		logger.warn('[budget] checkBudgetLimits failed; allowing request', { err })
		return { allowed: true, blockedBy: null, blockedSpendUsd: null, warnings: [] }
	}
}

/**
 * Record a budget threshold event into the immutable alerts log. Idempotent at the (limit,
 * trigger, period-start) level: if an alert already exists for this period/trigger, this is
 * a no-op so a single window doesn't fire repeated alerts on every check.
 *
 * A newly recorded alert also notifies the user — once per limit, trigger and period, for
 * the same reason. Nothing showed `budget_alerts` anywhere, so until this an alert was a
 * row no one would ever see.
 */
export async function recordBudgetAlert(input: {
	limit: BudgetLimitRow
	triggerType: 'warn' | 'block'
	spendUsd: number
	runId?: string | null
	now?: Date
}): Promise<{ inserted: boolean }> {
	const since = periodStart(input.limit.period, input.now ?? new Date())
	const [existing] = await db
		.select({ id: budgetAlerts.id })
		.from(budgetAlerts)
		.where(
			and(
				eq(budgetAlerts.budgetLimitId, input.limit.id),
				eq(budgetAlerts.triggerType, input.triggerType),
				gte(budgetAlerts.createdAt, since),
			),
		)
		.limit(1)
	if (existing) return { inserted: false }

	await db.insert(budgetAlerts).values({
		budgetLimitId: input.limit.id,
		userId: input.limit.userId,
		triggerType: input.triggerType,
		spendAtTrigger: input.spendUsd.toPrecision(15),
		limitUsd: input.limit.limitUsd,
		period: input.limit.period,
		runId: input.runId ?? null,
	})
	// Not awaited: a push can take seconds, and a blocked chat is waiting on its 402.
	void notifyBudgetAlert(input.limit, input.triggerType, input.spendUsd)
	return { inserted: true }
}

/** Record a warn alert for each limit the check found at or past its warning threshold. */
export async function recordBudgetWarnings(result: BudgetCheckResult, runId?: string | null): Promise<void> {
	for (const w of result.warnings) {
		try {
			await recordBudgetAlert({ limit: w.limit, triggerType: 'warn', spendUsd: w.spendUsd, runId })
		} catch (err) {
			logger.warn('[budget] warn alert insert failed', { err })
		}
	}
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`
}

const PERIOD_LABEL: Record<BudgetPeriod, string> = {
	day: 'daily',
	week: 'weekly',
	month: 'monthly',
	run: 'per-run',
}

async function notifyBudgetAlert(limit: BudgetLimitRow, triggerType: 'warn' | 'block', spendUsd: number) {
	try {
		const { notifyUser } = await import('$lib/notifications/notify.server')
		const limitText = `${formatUsd(parseFloat(limit.limitUsd))} ${PERIOD_LABEL[limit.period]} limit`
		// No category: a budget limit is something the user set up to hear about. It is
		// switched off by removing the limit, not by a notification setting.
		await notifyUser({
			userId: limit.userId,
			category: null,
			payload:
				triggerType === 'block'
					? {
							title: 'Budget limit reached',
							body: `${formatUsd(spendUsd)} spent against your ${limitText}. New runs are blocked until the period resets or the limit is raised.`,
							url: '/review',
							tag: `budget:${limit.id}:block`,
						}
					: {
							title: 'Budget nearly used',
							body: `${formatUsd(spendUsd)} spent against your ${limitText}.`,
							url: '/review',
							tag: `budget:${limit.id}:warn`,
						},
		})
	} catch (err) {
		logger.warn('[budget] alert notification failed (non-fatal)', { err })
	}
}
