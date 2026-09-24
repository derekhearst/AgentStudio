import { expect, test } from '@playwright/test'
import { carveParentUsage, subagentLedgerRows, type SubagentLedgerContext } from '../src/lib/costs/subagent-ledger'
import { readTurnUsage } from '../src/lib/engine/run-result'
import type { SubagentDetails } from '../src/lib/engine/tool-result-details'
import type { StreamBlock } from '../src/lib/runs/runs.schema'

/**
 * #32 — one ledger row per delegated child, carved out of the parent's row
 * (`src/lib/costs/subagent-ledger.ts`). Pure arithmetic; `recordSubagentUsage` writes it.
 */

const PARENT_AGENT = '00000000-0000-0000-0000-00000000000a'
const REVIEWER_ROW = '00000000-0000-0000-0000-00000000000b'

const context = (overrides: Partial<SubagentLedgerContext> = {}): SubagentLedgerContext => ({
	claudeRun: true,
	routedModel: 'claude-sonnet-4-5',
	conversationId: 'conv-1',
	parentAgentId: PARENT_AGENT,
	agentIdByKey: { reviewer: REVIEWER_ROW },
	...overrides,
})

function details(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return {
		kind: 'subagent',
		tool: 'Agent',
		status: 'completed',
		sdkAgentId: 'sdk-1',
		agentType: 'reviewer',
		report: 'ok',
		reportTruncated: false,
		totalTokens: 1_000,
		totalToolUseCount: 3,
		totalDurationMs: 2_000,
		usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 800 },
		resolvedModel: 'claude-haiku-4-5',
		...overrides,
	}
}

function child(id: string, agentName: string, d?: SubagentDetails, status: 'completed' | 'failed' | 'stopped' = 'completed') {
	return {
		kind: 'subagent',
		agentId: id,
		agentName,
		conversationId: null,
		task: 't',
		content: '',
		success: status === 'completed',
		status,
		...(d ? { details: d } : {}),
	} satisfies StreamBlock
}

/** What the engine added up over a child's model calls (`block.usage`). */
const spend = {
	inputTokens: 1_300,
	outputTokens: 450,
	cacheCreationTokens: 10,
	cacheReadTokens: 9_000,
	modelCalls: 7,
	model: 'claude-haiku-4-5-20251001',
}

test.describe('a row per child', () => {
	test('charged to the child agent, at the model it ended on, with its final call usage', () => {
		const [row] = subagentLedgerRows([child('a1', 'reviewer', details())], context())
		expect(row).toMatchObject({
			toolUseId: 'a1',
			agentKey: 'reviewer',
			agentId: REVIEWER_ROW,
			model: 'claude-haiku-4-5',
			tokensIn: 100,
			tokensOut: 50,
			tokensCacheWrite: 10,
			tokensCacheRead: 800,
		})
		expect(row.metadata).toMatchObject({ conversationId: 'conv-1', toolUseId: 'a1', sdkAgentId: 'sdk-1', usageBasis: 'final_call' })
	})

	test('costs nothing on the subscription and is priced from the catalogue on the gateway', () => {
		expect(subagentLedgerRows([child('a1', 'reviewer', details())], context())[0].costOverride).toBe(0)
		const gateway = subagentLedgerRows(
			[child('a1', 'reviewer', details({ resolvedModel: null }))],
			context({ claudeRun: false, routedModel: 'openai/gpt-5' }),
		)[0]
		expect(gateway.costOverride).toBeUndefined()
		expect(gateway.model).toBe('openai/gpt-5')
	})

	test("a child with no agents row of ours is charged to the parent's agent", () => {
		const [row] = subagentLedgerRows(
			[child('a1', 'general-purpose', details({ agentType: 'general-purpose' }))],
			context(),
		)
		expect(row.agentId).toBe(PARENT_AGENT)
	})

	test('a child that spent nothing anyone saw has no row: refused, or still launching', () => {
		const rows = subagentLedgerRows(
			[
				child('a1', 'reviewer', undefined, 'failed'),
				child('a2', 'reviewer', undefined, 'stopped'),
				child('a3', 'reviewer', details({ status: 'async_launched', usage: null })),
				child('a4', 'reviewer', details({ usage: null })),
				{ ...child('a5', 'reviewer'), usage: { ...spend, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } },
				{ kind: 'text', content: 'parent prose' },
			],
			context(),
		)
		expect(rows).toEqual([])
	})
})

test.describe("a row carries everything the child's calls spent", () => {
	test('the sum over its model calls, not the final call the SDK reports', () => {
		const [row] = subagentLedgerRows([{ ...child('a1', 'reviewer', details()), usage: spend }], context())
		expect(row).toMatchObject({ tokensIn: 1_300, tokensOut: 450, tokensCacheWrite: 10, tokensCacheRead: 9_000 })
		expect(row.metadata).toMatchObject({ usageBasis: 'model_calls', modelCalls: 7, status: 'completed' })
		// The SDK's resolved name still wins for the model column.
		expect(row.model).toBe('claude-haiku-4-5')
	})

	test('a failed or stopped child is charged for what it spent before it ended', () => {
		const rows = subagentLedgerRows(
			[
				{ ...child('a1', 'reviewer', undefined, 'stopped'), usage: spend },
				{ ...child('a2', 'reviewer', undefined, 'failed'), usage: { ...spend, modelCalls: 2 } },
			],
			context(),
		)
		expect(rows.map((r) => [r.toolUseId, r.tokensIn, r.metadata.status])).toEqual([
			['a1', 1_300, 'stopped'],
			['a2', 1_300, 'failed'],
		])
		// With no typed result, the model is what its own calls said, on the Claude login.
		expect(rows[0].model).toBe('claude-haiku-4-5-20251001')
		// On the gateway those names are not the catalogue's, so the parent's model is priced.
		const gateway = subagentLedgerRows(
			[{ ...child('a1', 'reviewer', undefined, 'stopped'), usage: spend }],
			context({ claudeRun: false, routedModel: 'openai/gpt-5' }),
		)
		expect(gateway[0].model).toBe('openai/gpt-5')
	})
})

test.describe("the parent's row is what is left", () => {
	const turn = { inputTokens: 1_000, outputTokens: 400, cacheCreationTokens: 20, cacheReadTokens: 5_000, costUsd: 0.5 }
	const kids = [
		{ tokensIn: 100, tokensOut: 50, tokensCacheWrite: 10, tokensCacheRead: 800 },
		{ tokensIn: 200, tokensOut: 30, tokensCacheWrite: 0, tokensCacheRead: 1_200 },
	]

	test('a turn figure that includes the children has them carved out, so the total is unchanged', () => {
		const parent = carveParentUsage(turn, { tokens: true, cost: true }, kids, 0.2)
		expect(parent).toMatchObject({
			inputTokens: 700,
			outputTokens: 320,
			cacheCreationTokens: 10,
			cacheReadTokens: 3_000,
		})
		expect(parent.costUsd).toBeCloseTo(0.3, 10)
		// Parent + children = the turn, field by field.
		expect(parent.inputTokens + 100 + 200).toBe(turn.inputTokens)
		expect(parent.costUsd! + 0.2).toBeCloseTo(turn.costUsd, 10)
	})

	test("a main-loop-only figure never had the children in it, so they are added, not carved", () => {
		expect(carveParentUsage({ ...turn, costUsd: null }, { tokens: false, cost: false }, kids, 0.2)).toEqual({
			...turn,
			costUsd: null,
		})
	})

	test('the halves are carved independently when a producer mixes them', () => {
		// The no-modelUsage producer: main-loop tokens, but a total_cost_usd with the children in it.
		const parent = carveParentUsage(turn, { tokens: false, cost: true }, kids, 0.2)
		expect(parent.inputTokens).toBe(1_000)
		expect(parent.costUsd).toBeCloseTo(0.3, 10)
	})

	test('never negative, whatever a producer reports', () => {
		const parent = carveParentUsage(
			{ inputTokens: 10, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.01 },
			{ tokens: true, cost: true },
			kids,
			5,
		)
		expect(parent).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 })
	})
})

test.describe('the turn figure says whether it includes the children', () => {
	const result = (extra: Record<string, unknown> = {}) => ({
		type: 'result',
		session_id: 's1',
		usage: { input_tokens: 10, output_tokens: 5 },
		total_cost_usd: 0.02,
		modelUsage: { m: { inputTokens: 300, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 } },
		...extra,
	})

	test('modelUsage counts every call of the query, children included', () => {
		expect(readTurnUsage(result(), { resumed: false, baseline: null }).includesSubagents).toEqual({ tokens: true, cost: true })
	})

	test('a resumed turn with nothing to subtract falls back to the main loop alone', () => {
		expect(readTurnUsage(result(), { resumed: true, baseline: null }).includesSubagents).toEqual({
			tokens: false,
			cost: false,
		})
	})

	test('a producer with no modelUsage: main-loop tokens, but a cost with the children in it', () => {
		expect(readTurnUsage(result({ modelUsage: undefined }), { resumed: false, baseline: null }).includesSubagents).toEqual({
			tokens: false,
			cost: true,
		})
	})
})
