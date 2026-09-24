import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'
import type { StreamBlock } from '../src/lib/runs/runs.schema'

/**
 * #32 against the database: a delegated child's ledger row, and the budget check a child
 * must pass before it starts. The arithmetic is pinned in `costs.subagent-ledger.spec.ts`;
 * this pins that the rows land where budgets and /activity read them.
 *
 * Serialized with the other specs that write this user's ledger and limits — see
 * `acquireGlobalStateLock` in helpers.
 */

let releaseBudgetLock: (() => Promise<void>) | null = null
test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
})
test.afterEach(async () => {
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

async function seed(prefix: string) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [parent] = await sql<{ id: string }[]>`
		insert into agents (name, role, system_prompt, model, status)
		values (${`${prefix} parent`}, ${`${prefix} role`}, '', 'anthropic/claude-sonnet-4', 'idle')
		returning id
	`
	const [child] = await sql<{ id: string }[]>`
		insert into agents (name, role, system_prompt, model, status)
		values (${`${prefix} reviewer`}, ${`${prefix} role`}, '', 'anthropic/claude-sonnet-4', 'idle')
		returning id
	`
	const [convo] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, agent_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, ${parent.id}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, agent_id, state, source, label)
		values (${convo.id}, ${userId}, ${parent.id}, 'running', 'chat_stream', ${`${prefix} run`})
		returning id
	`
	return { userId, parentId: parent.id, childId: child.id, conversationId: convo.id, runId: run.id }
}

async function cleanup(prefix: string, ids: { userId: string; runId: string; parentId: string; childId: string }) {
	const sql = getSql()
	await sql`delete from llm_usage where run_id = ${ids.runId}`
	await sql`delete from llm_usage where agent_id in (${ids.parentId}, ${ids.childId})`
	await sql`delete from budget_limits where user_id = ${ids.userId} and scope = 'agent' and scope_id in (${ids.parentId}, ${ids.childId})`
	await sql`delete from chat_runs where id = ${ids.runId}`
	await cleanupPrefixedRecords(prefix)
}

test('a completed child gets its own subagent row, charged to its own agent, carved out of the turn', async () => {
	const prefix = uniquePrefix('subagent-ledger')
	await cleanupPrefixedRecords(prefix)
	const ids = await seed(prefix)
	try {
		const { recordSubagentUsage } = await import('../src/lib/costs/subagent-ledger.server')
		const blocks: StreamBlock[] = [
			{
				kind: 'subagent',
				agentId: 'toolu_child_1',
				agentName: 'reviewer',
				conversationId: null,
				task: 'Review it',
				content: 'ok',
				success: true,
				status: 'completed',
				details: {
					kind: 'subagent',
					tool: 'Agent',
					status: 'completed',
					sdkAgentId: 'sdk-1',
					agentType: 'reviewer',
					report: 'ok',
					reportTruncated: false,
					totalTokens: 900,
					totalToolUseCount: 1,
					totalDurationMs: 1_000,
					usage: { inputTokens: 100, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 700 },
					resolvedModel: 'claude-haiku-4-5',
				},
			},
			// Refused: nothing reported, so no row.
			{
				kind: 'subagent',
				agentId: 'toolu_child_2',
				agentName: 'reviewer',
				conversationId: null,
				task: 'Again',
				content: '',
				success: false,
				status: 'failed',
				error: 'Refused: over the cap',
			},
		]

		const { parentUsage, childCostUsd } = await recordSubagentUsage({
			blocks,
			usage: { inputTokens: 1_000, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 5_000, costUsd: 0 },
			coverage: { tokens: true, cost: true },
			claudeRun: true,
			routedModel: 'claude-sonnet-4-5',
			conversationId: ids.conversationId,
			parentAgentId: ids.parentId,
			agentIdByKey: { reviewer: ids.childId },
			userId: ids.userId,
			runId: ids.runId,
		})

		expect(childCostUsd).toBe(0)
		expect(parentUsage).toMatchObject({ inputTokens: 900, outputTokens: 260, cacheReadTokens: 4_300 })

		const sql = getSql()
		const rows = await sql<
			{ source: string; model: string; tokens_in: number; tokens_out: number; cost: string; agent_id: string; metadata: Record<string, unknown> }[]
		>`select source, model, tokens_in, tokens_out, cost, agent_id, metadata from llm_usage where run_id = ${ids.runId}`
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			source: 'subagent',
			model: 'claude-haiku-4-5',
			tokens_in: 100,
			tokens_out: 40,
			agent_id: ids.childId,
		})
		expect(parseFloat(rows[0].cost)).toBe(0)
		expect(rows[0].metadata).toMatchObject({ toolUseId: 'toolu_child_1', subagentType: 'reviewer', usageBasis: 'final_call' })

		// The card's cost is stamped before the blocks persist; the refused one has none.
		expect(blocks[0].kind === 'subagent' && blocks[0].costUsd).toBe(0)
		expect(blocks[1].kind === 'subagent' && blocks[1].costUsd).toBeUndefined()
	} finally {
		await cleanup(prefix, ids)
	}
})

test("a child whose agent is over its budget is refused before it starts", async () => {
	const prefix = uniquePrefix('subagent-budget')
	await cleanupPrefixedRecords(prefix)
	const ids = await seed(prefix)
	const sql = getSql()
	try {
		// The child agent has already spent past an agent-scoped daily block limit.
		await sql`
			insert into budget_limits (user_id, scope, scope_id, period, limit_usd, action, enabled)
			values (${ids.userId}, 'agent', ${ids.childId}, 'day', '0.01', 'block', true)
		`
		await sql`
			insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id, agent_id, metadata)
			values ('subagent', 'claude-haiku-4-5', 10, 10, '1.00', ${ids.userId}, ${ids.childId}, '{}'::jsonb)
		`

		const { createChatDelegationGate } = await import('../src/lib/chat/stream-delegation.server')
		const gate = createChatDelegationGate({
			userId: ids.userId,
			conversationId: ids.conversationId,
			parentAgentId: ids.parentId,
			agentIdByKey: { reviewer: ids.childId },
			parentIsClaude: true,
		})
		const verdict = await gate.admit({ toolUseId: 'toolu_1', toolInput: { subagent_type: 'reviewer', prompt: 'p' } })
		expect(verdict.admit).toBe(false)
		expect(!verdict.admit && verdict.reason).toMatch(/^Refused: Budget cap exceeded: .* limit/)
		expect(gate.live()).toBe(0)
	} finally {
		await sql`delete from budget_alerts where user_id = ${ids.userId} and budget_limit_id in (select id from budget_limits where scope_id = ${ids.childId})`
		await cleanup(prefix, ids)
	}
})
