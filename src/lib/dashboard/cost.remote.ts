import { query } from '$app/server'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/server/db'
import { agentRuns, conversations, messages } from '$lib/server/db/schema'

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

	const [totalSpend, byModel, byConversation, dailyBreakdown] = await Promise.all([
		// Total spend in period
		db
			.select({
				total: sql<string>`coalesce(sum(${messages.cost}::numeric), 0)::text`,
				totalTokensIn: sql<number>`coalesce(sum(${messages.tokensIn}), 0)::int`,
				totalTokensOut: sql<number>`coalesce(sum(${messages.tokensOut}), 0)::int`,
				messageCount: sql<number>`count(*)::int`,
			})
			.from(messages)
			.where(gte(messages.createdAt, since)),

		// Cost by model
		db
			.select({
				model: messages.model,
				cost: sql<string>`coalesce(sum(${messages.cost}::numeric), 0)::text`,
				tokensIn: sql<number>`coalesce(sum(${messages.tokensIn}), 0)::int`,
				tokensOut: sql<number>`coalesce(sum(${messages.tokensOut}), 0)::int`,
				count: sql<number>`count(*)::int`,
			})
			.from(messages)
			.where(and(gte(messages.createdAt, since), sql`${messages.model} is not null`))
			.groupBy(messages.model)
			.orderBy(sql`sum(${messages.cost}::numeric) desc`),

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

		// Daily spend breakdown
		db
			.select({
				date: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`,
				cost: sql<string>`coalesce(sum(${messages.cost}::numeric), 0)::text`,
				count: sql<number>`count(*)::int`,
			})
			.from(messages)
			.where(gte(messages.createdAt, since))
			.groupBy(sql`date_trunc('day', ${messages.createdAt})`)
			.orderBy(sql`date_trunc('day', ${messages.createdAt})`),
	])

	// Agent run costs
	const agentCosts = await db
		.select({
			total: sql<string>`coalesce(sum(${agentRuns.cost}::numeric), 0)::text`,
			runCount: sql<number>`count(*)::int`,
		})
		.from(agentRuns)
		.where(gte(agentRuns.startedAt, since))

	return {
		period: p,
		since: since.toISOString(),
		totalSpend: totalSpend[0]?.total ?? '0',
		totalTokensIn: totalSpend[0]?.totalTokensIn ?? 0,
		totalTokensOut: totalSpend[0]?.totalTokensOut ?? 0,
		messageCount: totalSpend[0]?.messageCount ?? 0,
		agentSpend: agentCosts[0]?.total ?? '0',
		agentRunCount: agentCosts[0]?.runCount ?? 0,
		byModel,
		topConversations: byConversation,
		dailyBreakdown,
	}
})

export const getBudgetStatus = query(async () => {
	const today = new Date()
	const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
	const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

	const [dailySpend, monthlySpend] = await Promise.all([
		db
			.select({ total: sql<string>`coalesce(sum(${messages.cost}::numeric), 0)::text` })
			.from(messages)
			.where(gte(messages.createdAt, dayStart)),
		db
			.select({ total: sql<string>`coalesce(sum(${messages.cost}::numeric), 0)::text` })
			.from(messages)
			.where(gte(messages.createdAt, monthStart)),
	])

	return {
		dailySpend: dailySpend[0]?.total ?? '0',
		monthlySpend: monthlySpend[0]?.total ?? '0',
	}
})
