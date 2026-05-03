import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { automations } from '$lib/automations/automation.schema'
import { computeNextRunAt } from '$lib/automations/engine'

export type AgentStatus = (typeof agents.$inferSelect)['status']

export async function listAgentsWithCounts() {
	const agentRows = await db.select().from(agents).orderBy(asc(agents.createdAt))
	if (agentRows.length === 0) return []

	const agg = await db
		.select({
			agentId: conversations.agentId,
			sessionCount: sql<number>`COUNT(${conversations.id})::int`,
			totalCost: sql<string>`COALESCE(SUM(${conversations.totalCost}), '0')`,
			totalTokens: sql<number>`COALESCE(SUM(${conversations.totalTokens}), 0)::int`,
			lastActiveAt: sql<string | null>`MAX(${conversations.updatedAt})`,
		})
		.from(conversations)
		.where(isNotNull(conversations.agentId))
		.groupBy(conversations.agentId)

	const aggMap = new Map(agg.map((row) => [row.agentId!, row]))

	return agentRows.map((agent) => {
		const a = aggMap.get(agent.id)
		return {
			...agent,
			sessionCount: a?.sessionCount ?? 0,
			totalCost: a?.totalCost ?? '0',
			totalTokens: a?.totalTokens ?? 0,
			lastActiveAt: a?.lastActiveAt ? new Date(a.lastActiveAt) : null,
		}
	})
}

export async function getAgentDetail(agentId: string) {
	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	if (!agent) return null

	const chats = await db
		.select()
		.from(conversations)
		.where(eq(conversations.agentId, agentId))
		.orderBy(desc(conversations.updatedAt))
		.limit(50)

	// Message counts per conversation
	const msgCountMap = new Map<string, number>()
	if (chats.length > 0) {
		const convIds = chats.map((c) => c.id)
		const msgCounts = await db
			.select({
				conversationId: messages.conversationId,
				count: sql<number>`COUNT(*)::int`,
			})
			.from(messages)
			.where(inArray(messages.conversationId, convIds))
			.groupBy(messages.conversationId)
		for (const row of msgCounts) msgCountMap.set(row.conversationId, row.count)
	}

	// Aggregate stats for this agent across all its conversations
	const [statsRow] = await db
		.select({
			sessionCount: sql<number>`COUNT(*)::int`,
			totalCost: sql<string>`COALESCE(SUM(${conversations.totalCost}), '0')`,
			totalTokens: sql<number>`COALESCE(SUM(${conversations.totalTokens}), 0)::int`,
			avgCostPerSession: sql<string>`COALESCE(AVG(${conversations.totalCost}), '0')`,
		})
		.from(conversations)
		.where(eq(conversations.agentId, agentId))

	// Average first-token latency from assistant messages
	let avgTtftMs: number | null = null
	if (chats.length > 0) {
		const convIds = chats.map((c) => c.id)
		const [ttftRow] = await db
			.select({ avgTtftMs: sql<number | null>`AVG(${messages.ttftMs})::int` })
			.from(messages)
			.where(and(inArray(messages.conversationId, convIds), eq(messages.role, 'assistant'), isNotNull(messages.ttftMs)))
		avgTtftMs = ttftRow?.avgTtftMs ?? null
	}

	// Tool usage: aggregate tool call names from assistant messages
	let toolUsage: Array<{ name: string; count: number }> = []
	if (chats.length > 0) {
		const convIds = chats.map((c) => c.id)
		const toolMsgs = await db
			.select({ toolCalls: messages.toolCalls })
			.from(messages)
			.where(and(inArray(messages.conversationId, convIds), eq(messages.role, 'assistant')))
		const toolCounts = new Map<string, number>()
		for (const row of toolMsgs) {
			for (const tc of row.toolCalls ?? []) {
				const name = (tc as { name?: string }).name
				if (name) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
			}
		}
		toolUsage = [...toolCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 12)
	}

	// Automations configured for this agent
	const agentAutomations = await db
		.select()
		.from(automations)
		.where(eq(automations.agentId, agentId))
		.orderBy(asc(automations.createdAt))

	const conversationsWithStats = chats.map((c) => ({
		...c,
		messageCount: msgCountMap.get(c.id) ?? 0,
	}))

	return {
		agent,
		conversations: conversationsWithStats,
		stats: {
			sessionCount: statsRow?.sessionCount ?? 0,
			totalCost: statsRow?.totalCost ?? '0',
			totalTokens: statsRow?.totalTokens ?? 0,
			avgCostPerSession: statsRow?.avgCostPerSession ?? '0',
			avgTtftMs,
		},
		toolUsage,
		automations: agentAutomations,
	}
}

export async function updateAgentRecord(
	agentId: string,
	patch: {
		name?: string
		role?: string
		systemPrompt?: string
		model?: string
		// Wave 2 #8 phase 4 — let operators bind which capability groups an agent gets by
		// default (instead of the legacy "all tools" surface for agents without allowedTools).
		// Lives in agent.config.capabilityGroups; the stream handler reads it on run start.
		capabilityGroups?: string[]
		// Optional fine-grained override: a fixed allow-list of tool names (no progressive
		// disclosure). Empty/undefined means use capabilityGroups (or fall back to legacy).
		allowedTools?: string[]
	},
) {
	const updates: Partial<typeof agents.$inferInsert> = {}
	if (patch.name !== undefined) updates.name = patch.name
	if (patch.role !== undefined) updates.role = patch.role
	if (patch.systemPrompt !== undefined) updates.systemPrompt = patch.systemPrompt
	if (patch.model !== undefined) updates.model = patch.model

	const configChanged = patch.capabilityGroups !== undefined || patch.allowedTools !== undefined
	if (configChanged) {
		// Read existing config so we don't clobber unrelated keys (workspace, etc.).
		const [current] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId))
		const existing = (current?.config ?? {}) as Record<string, unknown>
		const nextConfig: Record<string, unknown> = { ...existing }
		if (patch.capabilityGroups !== undefined) {
			if (patch.capabilityGroups.length === 0) {
				delete nextConfig.capabilityGroups
			} else {
				nextConfig.capabilityGroups = patch.capabilityGroups
			}
		}
		if (patch.allowedTools !== undefined) {
			if (patch.allowedTools.length === 0) {
				delete nextConfig.allowedTools
			} else {
				nextConfig.allowedTools = patch.allowedTools
			}
		}
		updates.config = nextConfig
	}

	if (Object.keys(updates).length === 0) return null

	const [updated] = await db.update(agents).set(updates).where(eq(agents.id, agentId)).returning()
	return updated ?? null
}

export async function setAgentStatus(agentId: string, status: AgentStatus) {
	const [updated] = await db.update(agents).set({ status }).where(eq(agents.id, agentId)).returning()
	return updated ?? null
}
