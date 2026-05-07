import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { budgetAlerts, budgetLimits, llmUsage, toolUsage } from '$lib/costs/usage.schema'
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
	try {
		const rows = (await db
			.select()
			.from(budgetLimits)
			.where(and(eq(budgetLimits.userId, ctx.userId), eq(budgetLimits.enabled, true)))) as BudgetLimitRow[]

		const projection = Math.max(0, ctx.projectedCostUsd ?? 0)
		const result: BudgetCheckResult = { allowed: true, blockedBy: null, warnings: [] }

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
				result.allowed = false
			}
		}

		return result
	} catch (err) {
		logger.warn('[budget] checkBudgetLimits failed; allowing request', { err })
		return { allowed: true, blockedBy: null, warnings: [] }
	}
}

/**
 * Record a budget threshold event into the immutable alerts log. Idempotent at the (limit,
 * trigger, period-start) level: if an alert already exists for this period/trigger, this is
 * a no-op so a single window doesn't fire repeated alerts on every check.
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
	return { inserted: true }
}
