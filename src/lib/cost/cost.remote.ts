import { query } from '$app/server'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/chat/chat.schema'
import { llmUsage } from '$lib/cost/usage.schema'

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

	const [totalSpend, byModel, bySource, byConversation, dailyBreakdown] = await Promise.all([
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

		// Cost by source (chat, agent, titlegen, memory, etc.)
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
	])

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
