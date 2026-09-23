import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql, type AnyColumn } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { llmUsage, toolUsage } from '$lib/costs/usage.schema'
import { agents } from '$lib/agents/agents.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { automationRuns, automations } from '$lib/automations/automation.schema'
import { monitors } from '$lib/monitors/monitors.schema'
import { reviewItems } from '$lib/observability/observability.schema'
import { listBudgetHeadroom } from '$lib/costs/budget.server'
import {
	DEFAULT_USAGE_DIGEST_DAYS,
	MONITOR_ERROR_STREAK_ALERT,
	assembleUsageDigest,
	resolveDigestWindow,
	type DigestBudgetHeadroom,
	type DigestWindow,
	type UsageDigest,
	type UsageDigestInput,
} from '$lib/costs/usage-digest'

/**
 * #38 — the queries behind the usage digest. Assembly, anomalies and markdown are in the
 * pure `usage-digest.ts`; this file only reads.
 *
 * ## Whose numbers
 *
 * The ledgers are read instance-wide, the same way `getCostSummary` reads them: the
 * deployment has one owner, and background work (embeddings, title generation, memory
 * mining) records usage with no user at all, so a per-user filter would under-report.
 * Automations, monitors and budget limits carry an owner and are read for that owner.
 *
 * ## Units
 *
 * Sums come back as float8, not int: thirty days of cache reads can pass 2^31 tokens, and a
 * cast to int would throw rather than overflow quietly. Window bounds go into raw SQL as
 * ISO strings with a cast, because the postgres-js driver is configured to pass timestamp
 * parameters through untouched and a `Date` there is not serialized.
 */

/** Rows fetched per breakdown before the pure assembler trims to its top N. */
const QUERY_LIMIT = 10

export async function computeUsageDigest(input: {
	userId: string
	days?: number
	now?: Date
}): Promise<UsageDigest> {
	const window = resolveDigestWindow(input.days ?? DEFAULT_USAGE_DIGEST_DAYS, input.now)
	return assembleUsageDigest(await loadUsageDigestInput(input.userId, window))
}

async function loadUsageDigestInput(userId: string, window: DigestWindow): Promise<UsageDigestInput> {
	const since = window.since.toISOString()
	const until = window.until.toISOString()
	const afterSince = (column: AnyColumn) => sql`${column} >= ${since}::timestamptz`

	const [llmTotals, models, agentRows, toolTotals, topTools, runStates, automationRows, inboxRows, monitorRows, budget] =
		await Promise.all([
			// Both windows in one pass; FILTER splits them.
			db
				.select({
					tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}) filter (where ${afterSince(llmUsage.createdAt)}), 0)::float8`,
					tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}) filter (where ${afterSince(llmUsage.createdAt)}), 0)::float8`,
					tokensCacheRead: sql<number>`coalesce(sum(${llmUsage.tokensCacheRead}) filter (where ${afterSince(llmUsage.createdAt)}), 0)::float8`,
					tokensCacheWrite: sql<number>`coalesce(sum(${llmUsage.tokensCacheWrite}) filter (where ${afterSince(llmUsage.createdAt)}), 0)::float8`,
					costUsd: sql<number>`coalesce(sum(${llmUsage.cost}::numeric) filter (where ${afterSince(llmUsage.createdAt)}), 0)::float8`,
					calls: sql<number>`(count(*) filter (where ${afterSince(llmUsage.createdAt)}))::int`,
					prevTokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}) filter (where ${llmUsage.createdAt} < ${since}::timestamptz), 0)::float8`,
					prevTokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}) filter (where ${llmUsage.createdAt} < ${since}::timestamptz), 0)::float8`,
					prevCacheRead: sql<number>`coalesce(sum(${llmUsage.tokensCacheRead}) filter (where ${llmUsage.createdAt} < ${since}::timestamptz), 0)::float8`,
					prevCacheWrite: sql<number>`coalesce(sum(${llmUsage.tokensCacheWrite}) filter (where ${llmUsage.createdAt} < ${since}::timestamptz), 0)::float8`,
					prevCostUsd: sql<number>`coalesce(sum(${llmUsage.cost}::numeric) filter (where ${llmUsage.createdAt} < ${since}::timestamptz), 0)::float8`,
					prevCalls: sql<number>`(count(*) filter (where ${llmUsage.createdAt} < ${since}::timestamptz))::int`,
				})
				.from(llmUsage)
				.where(and(gte(llmUsage.createdAt, window.prevSince), lt(llmUsage.createdAt, window.until))),

			db
				.select({
					model: llmUsage.model,
					tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::float8`,
					tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::float8`,
					tokensCacheRead: sql<number>`coalesce(sum(${llmUsage.tokensCacheRead}), 0)::float8`,
					tokensCacheWrite: sql<number>`coalesce(sum(${llmUsage.tokensCacheWrite}), 0)::float8`,
					costUsd: sql<number>`coalesce(sum(${llmUsage.cost}::numeric), 0)::float8`,
					calls: sql<number>`count(*)::int`,
					// The chat stream stamps `metadata.subscription` on every turn it logs at $0.
					subscription: sql<boolean>`coalesce(bool_or(${llmUsage.metadata}->>'subscription' = 'true'), false)`,
				})
				.from(llmUsage)
				.where(and(gte(llmUsage.createdAt, window.since), lt(llmUsage.createdAt, window.until)))
				.groupBy(llmUsage.model)
				.orderBy(sql`sum(${llmUsage.tokensIn} + ${llmUsage.tokensOut}) desc`)
				.limit(QUERY_LIMIT),

			db
				.select({
					agentId: sql<string>`${llmUsage.agentId}`,
					name: agents.name,
					tokensIn: sql<number>`coalesce(sum(${llmUsage.tokensIn}), 0)::float8`,
					tokensOut: sql<number>`coalesce(sum(${llmUsage.tokensOut}), 0)::float8`,
					costUsd: sql<number>`coalesce(sum(${llmUsage.cost}::numeric), 0)::float8`,
					calls: sql<number>`count(*)::int`,
				})
				.from(llmUsage)
				.leftJoin(agents, eq(agents.id, llmUsage.agentId))
				.where(
					and(
						gte(llmUsage.createdAt, window.since),
						lt(llmUsage.createdAt, window.until),
						isNotNull(llmUsage.agentId),
					),
				)
				.groupBy(llmUsage.agentId, agents.name)
				.orderBy(sql`sum(${llmUsage.tokensIn} + ${llmUsage.tokensOut}) desc`)
				.limit(QUERY_LIMIT),

			// Calls are the `call`-unit rows; paid tools also write credit/second rows for the
			// same call, which carry the spend but must not be counted as a second call.
			db
				.select({
					calls: sql<number>`(count(*) filter (where ${toolUsage.unitType} = 'call' and ${afterSince(toolUsage.createdAt)}))::int`,
					failed: sql<number>`(count(*) filter (where ${toolUsage.unitType} = 'call' and ${toolUsage.metadata}->>'success' = 'false' and ${afterSince(toolUsage.createdAt)}))::int`,
					costUsd: sql<number>`coalesce(sum(${toolUsage.cost}::numeric) filter (where ${afterSince(toolUsage.createdAt)}), 0)::float8`,
					previousCostUsd: sql<number>`coalesce(sum(${toolUsage.cost}::numeric) filter (where ${toolUsage.createdAt} < ${since}::timestamptz), 0)::float8`,
				})
				.from(toolUsage)
				.where(and(gte(toolUsage.createdAt, window.prevSince), lt(toolUsage.createdAt, window.until))),

			db
				.select({
					toolName: toolUsage.toolName,
					calls: sql<number>`(count(*) filter (where ${toolUsage.unitType} = 'call'))::int`,
					failed: sql<number>`(count(*) filter (where ${toolUsage.unitType} = 'call' and ${toolUsage.metadata}->>'success' = 'false'))::int`,
					costUsd: sql<number>`coalesce(sum(${toolUsage.cost}::numeric), 0)::float8`,
				})
				.from(toolUsage)
				.where(and(gte(toolUsage.createdAt, window.since), lt(toolUsage.createdAt, window.until)))
				.groupBy(toolUsage.toolName)
				.orderBy(sql`count(*) filter (where ${toolUsage.unitType} = 'call') desc`)
				.limit(QUERY_LIMIT),

			db
				.select({ state: chatRuns.state, count: sql<number>`count(*)::int` })
				.from(chatRuns)
				.where(and(gte(chatRuns.createdAt, window.since), lt(chatRuns.createdAt, window.until)))
				.groupBy(chatRuns.state),

			// Both windows again: the previous window's failures decide whether one is new.
			db
				.select({
					automationId: automationRuns.automationId,
					description: automations.description,
					enabled: automations.enabled,
					disabledReason: automations.disabledReason,
					disabledInWindow: sql<boolean>`(${automations.disabledReason} is not null and ${afterSince(automations.updatedAt)})`,
					runs: sql<number>`(count(*) filter (where ${afterSince(automationRuns.startedAt)}))::int`,
					completed: sql<number>`(count(*) filter (where ${automationRuns.status} = 'completed' and ${afterSince(automationRuns.startedAt)}))::int`,
					failed: sql<number>`(count(*) filter (where ${automationRuns.status} = 'failed' and ${afterSince(automationRuns.startedAt)}))::int`,
					blocked: sql<number>`(count(*) filter (where ${automationRuns.status} = 'blocked' and ${afterSince(automationRuns.startedAt)}))::int`,
					costUsd: sql<number>`coalesce(sum(${automationRuns.costUsd}::numeric) filter (where ${afterSince(automationRuns.startedAt)}), 0)::float8`,
					prevFailed: sql<number>`(count(*) filter (where ${automationRuns.status} = 'failed' and ${automationRuns.startedAt} < ${since}::timestamptz))::int`,
				})
				.from(automationRuns)
				.innerJoin(automations, eq(automations.id, automationRuns.automationId))
				.where(
					and(
						eq(automations.userId, userId),
						gte(automationRuns.startedAt, window.prevSince),
						lt(automationRuns.startedAt, window.until),
					),
				)
				.groupBy(
					automationRuns.automationId,
					automations.description,
					automations.enabled,
					automations.disabledReason,
					automations.updatedAt,
				),

			// The inbox as it stands now, not as it stood during the window: "5 open" is a
			// to-do count. `review_items` has no owner column; the instance has one owner.
			db
				.select({ severity: reviewItems.severity, count: sql<number>`count(*)::int` })
				.from(reviewItems)
				.where(inArray(reviewItems.status, ['open', 'in_progress']))
				.groupBy(reviewItems.severity),

			// Only the monitors an anomaly rule could fire on.
			db
				.select({
					monitorId: monitors.id,
					name: monitors.name,
					status: monitors.status,
					fireCount: monitors.fireCount,
					consecutiveErrors: monitors.consecutiveErrors,
					updatedInWindow: sql<boolean>`(${afterSince(monitors.updatedAt)} and ${monitors.updatedAt} < ${until}::timestamptz)`,
				})
				.from(monitors)
				.where(
					and(
						eq(monitors.userId, userId),
						or(
							and(
								inArray(monitors.status, ['expired', 'exhausted', 'failed']),
								eq(monitors.fireCount, 0),
								gte(monitors.updatedAt, window.since),
								lt(monitors.updatedAt, window.until),
							),
							and(eq(monitors.status, 'active'), gte(monitors.consecutiveErrors, MONITOR_ERROR_STREAK_ALERT)),
						),
					),
				)
				.orderBy(desc(monitors.updatedAt))
				.limit(QUERY_LIMIT * 2),

			loadBudgetHeadroom(userId, window.until),
		])

	const llm = llmTotals[0]
	const tools = toolTotals[0]
	return {
		window,
		llm: {
			current: {
				tokensIn: llm?.tokensIn ?? 0,
				tokensOut: llm?.tokensOut ?? 0,
				tokensCacheRead: llm?.tokensCacheRead ?? 0,
				tokensCacheWrite: llm?.tokensCacheWrite ?? 0,
				costUsd: llm?.costUsd ?? 0,
				calls: llm?.calls ?? 0,
			},
			previous: {
				tokensIn: llm?.prevTokensIn ?? 0,
				tokensOut: llm?.prevTokensOut ?? 0,
				tokensCacheRead: llm?.prevCacheRead ?? 0,
				tokensCacheWrite: llm?.prevCacheWrite ?? 0,
				costUsd: llm?.prevCostUsd ?? 0,
				calls: llm?.prevCalls ?? 0,
			},
		},
		models,
		agents: agentRows,
		runStates,
		automations: automationRows,
		tools: {
			calls: tools?.calls ?? 0,
			failed: tools?.failed ?? 0,
			costUsd: tools?.costUsd ?? 0,
			previousCostUsd: tools?.previousCostUsd ?? 0,
			top: topTools,
		},
		budget,
		inbox: inboxRows,
		monitors: monitorRows,
	}
}

/** Headroom with a readable name for agent-scoped limits. */
async function loadBudgetHeadroom(userId: string, now: Date): Promise<DigestBudgetHeadroom[]> {
	const headroom = await listBudgetHeadroom(userId, now)
	const agentIds = headroom.filter((limit) => limit.scope === 'agent' && limit.scopeId).map((limit) => limit.scopeId!)
	const names = new Map<string, string>()
	if (agentIds.length > 0) {
		const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
		for (const row of rows) names.set(row.id, row.name)
	}
	return headroom.map((limit) => ({
		...limit,
		scopeLabel: limit.scopeId ? (names.get(limit.scopeId) ?? null) : null,
	}))
}
