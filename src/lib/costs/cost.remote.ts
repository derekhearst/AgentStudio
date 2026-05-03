import { command, query } from '$app/server'
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { budgetAlerts, budgetLimits, llmUsage, toolUsage } from '$lib/costs/usage.schema'
import { agents } from '$lib/agents/agents.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

const costPeriodSchema = z.object({
	period: z.enum(['day', 'week', 'month']).optional(),
})

function periodStart(period: 'day' | 'week' | 'month'): Date {
	const now = new Date()
	if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
	if (period === 'week') {
		const d = new Date(now)
		d.setDate(d.getDate() - d.getDay())
		d.setHours(0, 0, 0, 0)
		return d
	}
	return new Date(now.getFullYear(), now.getMonth(), 1)
}

export const getCostSummary = query(costPeriodSchema, async ({ period }) => {
	const p = period ?? 'month'
	const since = periodStart(p)

	const [
		totalSpend,
		byModel,
		bySource,
		byConversation,
		dailyBreakdown,
		byRun,
		byAgent,
		byTask,
		toolSpend,
		byTool,
	] = await Promise.all([
		// Total spend in period (from llm_usage — all LLM calls)
		db
			.select({
				total: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				totalTokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
				totalTokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
				callCount: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.where(gte(llmUsage.createdAt, since)),

		// Cost by model (from llm_usage)
		db
			.select({
				model: llmUsage.model,
				cost: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
				count: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.where(gte(llmUsage.createdAt, since))
			.groupBy(llmUsage.model)
			.orderBy(sql`sum(${llmUsage.cost}::numeric) desc`),

		// Cost by source (chat, agent, titlegen, etc.)
		db
			.select({
				source: llmUsage.source,
				cost: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
				count: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.where(gte(llmUsage.createdAt, since))
			.groupBy(llmUsage.source)
			.orderBy(sql`sum(${llmUsage.cost}::numeric) desc`),

		// Top conversations by cost
		db
			.select({
				id: conversations.id,
				title: conversations.title,
				totalCost: conversations.totalCost,
				model: conversations.model,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(gte(conversations.updatedAt, since))
			.orderBy(sql`${conversations.totalCost}::numeric desc`)
			.limit(10),

		// Daily spend breakdown (from llm_usage)
		db
			.select({
				date: sql<string>`date_trunc('day', ${llmUsage.createdAt})::date::text`,
				cost: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				count: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.where(gte(llmUsage.createdAt, since))
			.groupBy(sql`date_trunc('day', ${llmUsage.createdAt})`)
			.orderBy(sql`date_trunc('day', ${llmUsage.createdAt})`),

		// Top runs by cost
		db
			.select({
				runId: llmUsage.runId,
				label: chatRuns.label,
				state: chatRuns.state,
				source: chatRuns.source,
				cost: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
				count: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.leftJoin(chatRuns, eq(chatRuns.id, llmUsage.runId))
			.where(and(gte(llmUsage.createdAt, since), isNotNull(llmUsage.runId)))
			.groupBy(llmUsage.runId, chatRuns.label, chatRuns.state, chatRuns.source)
			.orderBy(sql`sum(${llmUsage.cost}::numeric) desc`)
			.limit(10),

		// Top agents by cost
		db
			.select({
				agentId: llmUsage.agentId,
				name: agents.name,
				role: agents.role,
				cost: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
				count: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.leftJoin(agents, eq(agents.id, llmUsage.agentId))
			.where(and(gte(llmUsage.createdAt, since), isNotNull(llmUsage.agentId)))
			.groupBy(llmUsage.agentId, agents.name, agents.role)
			.orderBy(sql`sum(${llmUsage.cost}::numeric) desc`)
			.limit(10),

		// Top tasks by cost (no FK yet — taskId is back-populated when the tasks domain lands)
		db
			.select({
				taskId: llmUsage.taskId,
				cost: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text`,
				tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::int`,
				count: sql<number>`count(*)::int`,
			})
			.from(llmUsage)
			.where(and(gte(llmUsage.createdAt, since), isNotNull(llmUsage.taskId)))
			.groupBy(llmUsage.taskId)
			.orderBy(sql`sum(${llmUsage.cost}::numeric) desc`)
			.limit(10),

		// Total non-LLM tool spend (web search credits, browser sessions, etc.)
		db
			.select({
				total: sql<string>`coalesce(sum(${toolUsage.cost}::numeric), 0)::text`,
				callCount: sql<number>`count(*)::int`,
			})
			.from(toolUsage)
			.where(gte(toolUsage.createdAt, since)),

		// Spend by tool name (mirrors byModel for the LLM side)
		db
			.select({
				toolName: toolUsage.toolName,
				provider: toolUsage.provider,
				unitType: toolUsage.unitType,
				units: sql<string>`coalesce(sum(${toolUsage.units}::numeric), 0)::text`,
				cost: sql<string>`coalesce(sum(${toolUsage.cost}::numeric), 0)::text`,
				count: sql<number>`count(*)::int`,
			})
			.from(toolUsage)
			.where(gte(toolUsage.createdAt, since))
			.groupBy(toolUsage.toolName, toolUsage.provider, toolUsage.unitType)
			.orderBy(sql`sum(${toolUsage.cost}::numeric) desc`)
			.limit(10),
	])

	const llmTotal = parseFloat(totalSpend[0]?.total ?? '0')
	const toolTotal = parseFloat(toolSpend[0]?.total ?? '0')

	return {
		period: p,
		since: since.toISOString(),
		totalSpend: totalSpend[0]?.total ?? '0',
		totalTokensIn: totalSpend[0]?.totalTokensIn ?? 0,
		totalTokensOut: totalSpend[0]?.totalTokensOut ?? 0,
		callCount: totalSpend[0]?.callCount ?? 0,
		byModel,
		bySource,
		topConversations: byConversation,
		dailyBreakdown,
		byRun,
		byAgent,
		byTask,
		// Non-LLM tool spend (Phase 2 of #5)
		toolSpend: toolSpend[0]?.total ?? '0',
		toolCallCount: toolSpend[0]?.callCount ?? 0,
		byTool,
		// Combined ledger total (LLM + tool) so the dashboard can show one true number.
		combinedSpend: (llmTotal + toolTotal).toPrecision(15),
	}
})

export const getBudgetStatus = query(async () => {
	const today = new Date()
	const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
	const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

	const [dailySpend, monthlySpend] = await Promise.all([
		db
			.select({ total: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text` })
			.from(llmUsage)
			.where(gte(llmUsage.createdAt, dayStart)),
		db
			.select({ total: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)::text` })
			.from(llmUsage)
			.where(gte(llmUsage.createdAt, monthStart)),
	])

	return {
		dailySpend: dailySpend[0]?.total ?? '0',
		monthlySpend: monthlySpend[0]?.total ?? '0',
	}
})

const budgetScopeSchema = z.enum(['global', 'project', 'agent', 'run'])
const budgetPeriodSchema = z.enum(['day', 'week', 'month', 'run'])
const budgetActionSchema = z.enum(['block', 'notify_only'])

const createBudgetLimitSchema = z.object({
	scope: budgetScopeSchema,
	scopeId: z.string().uuid().nullable().optional(),
	period: budgetPeriodSchema,
	limitUsd: z.coerce.number().positive(),
	warnUsd: z.coerce.number().positive().nullable().optional(),
	action: budgetActionSchema.default('block'),
	enabled: z.boolean().default(true),
})

const updateBudgetLimitSchema = z.object({
	id: z.string().uuid(),
	limitUsd: z.coerce.number().positive().optional(),
	warnUsd: z.coerce.number().positive().nullable().optional(),
	action: budgetActionSchema.optional(),
	enabled: z.boolean().optional(),
})

const deleteBudgetLimitSchema = z.object({ id: z.string().uuid() })

export const listBudgetLimits = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return db
		.select()
		.from(budgetLimits)
		.where(eq(budgetLimits.userId, user.id))
		.orderBy(desc(budgetLimits.createdAt))
})

export const createBudgetLimit = command(createBudgetLimitSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const [row] = await db
		.insert(budgetLimits)
		.values({
			userId: user.id,
			scope: input.scope,
			scopeId: input.scopeId ?? null,
			period: input.period,
			limitUsd: input.limitUsd.toFixed(6),
			warnUsd: input.warnUsd != null ? input.warnUsd.toFixed(6) : null,
			action: input.action,
			enabled: input.enabled,
		})
		.returning()
	return { success: true as const, limit: row }
})

export const updateBudgetLimit = command(updateBudgetLimitSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const updates: Record<string, unknown> = { updatedAt: new Date() }
	if (input.limitUsd !== undefined) updates.limitUsd = input.limitUsd.toFixed(6)
	if (input.warnUsd !== undefined) updates.warnUsd = input.warnUsd != null ? input.warnUsd.toFixed(6) : null
	if (input.action !== undefined) updates.action = input.action
	if (input.enabled !== undefined) updates.enabled = input.enabled
	const [row] = await db
		.update(budgetLimits)
		.set(updates)
		.where(and(eq(budgetLimits.id, input.id), eq(budgetLimits.userId, user.id)))
		.returning()
	return { success: row !== undefined, limit: row ?? null }
})

export const deleteBudgetLimit = command(deleteBudgetLimitSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await db
		.delete(budgetLimits)
		.where(and(eq(budgetLimits.id, input.id), eq(budgetLimits.userId, user.id)))
	return { success: true as const }
})

export const listBudgetAlerts = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return db
		.select()
		.from(budgetAlerts)
		.where(eq(budgetAlerts.userId, user.id))
		.orderBy(desc(budgetAlerts.createdAt))
		.limit(50)
})
