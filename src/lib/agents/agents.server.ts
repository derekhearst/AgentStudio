import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { automations } from '$lib/automations/automation.schema'
import { computeNextRunAt } from '$lib/automations/cron'
import { logger } from '$lib/observability/logger'
import {
	AVAILABLE_AGENT_STATUS,
	PAUSED_AGENT_STATUS,
	agentAvailability,
	isAgentPaused,
	pauseRefusal,
} from '$lib/agents/agent-status'

export type AgentStatus = (typeof agents.$inferSelect)['status']

/**
 * Every agent as the model sees it through `list_agents`: the full id every agent tool takes,
 * built-ins included and listed first. Before this there was no way for the model to learn an
 * id at all — the Plan agent's handoff (`request_plan_approval`) takes a full UUID, and so do
 * `update_agent`, `pause_agent` and `resume_agent`.
 */
export async function listAgentRoster() {
	const rows = await db
		.select({
			id: agents.id,
			name: agents.name,
			role: agents.role,
			kind: agents.kind,
			builtinKey: agents.builtinKey,
			status: agents.status,
		})
		.from(agents)
		.orderBy(sql`${agents.builtinKey} IS NULL`, asc(agents.createdAt))
	return rows.map(({ status, ...agent }) => ({ ...agent, availability: agentAvailability(status) }))
}

/** Every agent, with usage aggregated over `userId`'s own conversations. */
export async function listAgentsWithCounts(userId: string) {
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
		.where(and(isNotNull(conversations.agentId), eq(conversations.userId, userId)))
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

/**
 * One agent, with the conversations, stats and automations that belong to `userId`. The
 * agent row itself is shared; nothing else here is, the same rule the chat sidebar applies.
 */
export async function getAgentDetail(agentId: string, userId: string) {
	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	if (!agent) return null

	const chats = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.agentId, agentId), eq(conversations.userId, userId)))
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
		.where(and(eq(conversations.agentId, agentId), eq(conversations.userId, userId)))

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
		.where(and(eq(automations.agentId, agentId), eq(automations.userId, userId)))
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

/** An agent's stored model, or undefined when there is no such agent. */
export async function getAgentModel(agentId: string): Promise<string | undefined> {
	const [row] = await db.select({ model: agents.model }).from(agents).where(eq(agents.id, agentId)).limit(1)
	return row?.model
}

export async function updateAgentRecord(
	agentId: string,
	patch: {
		name?: string
		role?: string
		systemPrompt?: string
		model?: string
		// Optional fine-grained override: a fixed allow-list of tool names. When set, a chat
		// run offers the agent exactly this list; empty/undefined offers every tool. An
		// unattended old-loop run can only narrow its own short list with it
		// (`$lib/runtime/detached-tools`).
		allowedTools?: string[]
		// Wave 3 #13 phase 4 — per-agent hook bindings. Map of `event → hookRef[]`. Refs are either
		// registered built-in hook names OR future skill slugs (Phase 3). Empty array clears the
		// override for that event; an empty object clears all.
		hooks?: Record<string, string[] | undefined>
		// Wave 4 #18 phase 4 — per-agent research config overrides (resolveResearchConfig reads
		// this when a research run is triggered from a chat with this agent). Shape:
		// { enabled?, plannerModel?, synthesizerModel?, maxSubQuestions?, urlsPerQuestion?, maxFetchChars? }.
		// Empty object clears the override and falls back to DEFAULT_RESEARCH_CONFIG.
		research?: Record<string, unknown>
		// Wave 5 #22 phase 2 — link the agent to a skill whose content overrides the legacy
		// systemPrompt at runtime. Pass null to clear the linkage (falls back to systemPrompt).
		identitySkillId?: string | null
	},
) {
	const updates: Partial<typeof agents.$inferInsert> = {}
	if (patch.name !== undefined) updates.name = patch.name
	if (patch.role !== undefined) updates.role = patch.role
	if (patch.systemPrompt !== undefined) updates.systemPrompt = patch.systemPrompt
	if (patch.model !== undefined) updates.model = patch.model
	if (patch.identitySkillId !== undefined) updates.identitySkillId = patch.identitySkillId

	const configChanged =
		patch.allowedTools !== undefined || patch.hooks !== undefined || patch.research !== undefined
	if (configChanged) {
		// Read existing config so we don't clobber unrelated keys (workspace, etc.).
		const [current] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId))
		const existing = (current?.config ?? {}) as Record<string, unknown>
		const nextConfig: Record<string, unknown> = { ...existing }
		// Drop the legacy `capabilityGroups` field if a previous version of the agent had it.
		// Capability groups were retired and nothing reads them; leaving them would be silently ignored.
		delete nextConfig.capabilityGroups
		if (patch.allowedTools !== undefined) {
			if (patch.allowedTools.length === 0) {
				delete nextConfig.allowedTools
			} else {
				nextConfig.allowedTools = patch.allowedTools
			}
		}
		if (patch.hooks !== undefined) {
			const cleaned: Record<string, string[]> = {}
			for (const [event, refs] of Object.entries(patch.hooks)) {
				if (!refs) continue // schema allows missing values per-event
				const trimmed = refs.map((r) => r.trim()).filter((r) => r.length > 0)
				if (trimmed.length > 0) cleaned[event] = trimmed
			}
			if (Object.keys(cleaned).length === 0) {
				delete nextConfig.hooks
			} else {
				nextConfig.hooks = cleaned
			}
		}
		if (patch.research !== undefined) {
			// Strip undefined fields + reject if everything's empty (= clear the override).
			const cleaned: Record<string, unknown> = {}
			for (const [key, value] of Object.entries(patch.research)) {
				if (value !== undefined && value !== null) cleaned[key] = value
			}
			if (Object.keys(cleaned).length === 0) {
				delete nextConfig.research
			} else {
				nextConfig.research = cleaned
			}
		}
		updates.config = nextConfig
	}

	if (Object.keys(updates).length === 0) return null

	const [updated] = await db.update(agents).set(updates).where(eq(agents.id, agentId)).returning()
	return updated ?? null
}

/**
 * Write an agent's status and record the change in the audit trail. `actorUserId` is the
 * person who pressed Pause or Resume; the model's `pause_agent` / `resume_agent` tools pass
 * none, and their rows say so. Unguarded — callers deciding pause or resume go through
 * `setAgentPaused`, which applies the rule on who may be paused.
 */
export async function setAgentStatus(agentId: string, status: AgentStatus, actorUserId: string | null = null) {
	const [before] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId)).limit(1)
	const [updated] = await db.update(agents).set({ status }).where(eq(agents.id, agentId)).returning()
	if (!updated) return null
	const beforeStatus = before?.status ?? null
	if (beforeStatus !== status) {
		void (async () => {
			try {
				// The server module, not the `$lib/governance` barrel: the barrel also carries the
				// domain's remote functions, which only load inside SvelteKit.
				const { auditAgentStatusChanged } = await import('$lib/governance/governance.server')
				await auditAgentStatusChanged({
					actorUserId,
					agentId,
					beforeStatus,
					afterStatus: status,
				})
			} catch (err) {
				logger.warn('[agents] status-changed audit failed', { err })
			}
		})()
	}
	return updated
}

export type SetAgentPausedResult =
	| { ok: true; agent: typeof agents.$inferSelect }
	| { ok: false; reason: 'not_found' | 'not_pausable'; message: string }

/**
 * Pause or resume an agent (#66) — the one path the Pause button and the model's tools share,
 * so a built-in cannot be paused by either. See `$lib/agents/agent-status` for what pausing
 * means and why only user-created agents may be paused.
 *
 * Resuming an agent that is not paused changes nothing, rather than writing `active` over
 * `idle` and leaving an audit row for a change nobody made.
 */
export async function setAgentPaused(
	agentId: string,
	paused: boolean,
	actorUserId: string | null = null,
): Promise<SetAgentPausedResult> {
	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	if (!agent) return { ok: false, reason: 'not_found', message: 'Agent not found' }

	if (paused) {
		const refusal = pauseRefusal(agent)
		if (refusal) return { ok: false, reason: 'not_pausable', message: refusal }
		if (isAgentPaused(agent.status)) return { ok: true, agent }
	} else if (!isAgentPaused(agent.status)) {
		return { ok: true, agent }
	}

	const updated = await setAgentStatus(agentId, paused ? PAUSED_AGENT_STATUS : AVAILABLE_AGENT_STATUS, actorUserId)
	if (!updated) return { ok: false, reason: 'not_found', message: 'Agent not found' }
	return { ok: true, agent: updated }
}
