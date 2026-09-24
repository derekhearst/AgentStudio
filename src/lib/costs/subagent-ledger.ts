/**
 * Per-child cost attribution (#32): one `llm_usage` row for each delegated child, and the
 * parent's own row made smaller by the same amount.
 *
 * ## What a child spent
 *
 * The engine adds up every model call the child made, from the child's own messages as they
 * stream past (`block.usage`, see `$lib/engine/subagent-usage`). That is the figure a child's
 * row carries, whether the child completed, failed or was stopped partway.
 *
 * The SDK's own per-child figure is not that. A child that completes answers its `Agent` call
 * with a typed `AgentOutput` whose `usage` (`SubagentDetails.usage`), read in the bundled CLI
 * (2.1.278), is the child's LAST model call only. It is used on its own only when no call of
 * the child's was seen in the stream (`usageBasis: 'final_call'`), and otherwise it is folded
 * into the sum as that last call. The `result` message's `modelUsage` covers every call of
 * the turn, children included, but per model, not per child.
 *
 * ## The turn's total stays exact
 *
 * The parent's row is the turn's measured usage (`./run-result`), and when that figure is
 * read from `modelUsage` it already includes every child. A child row is therefore carved
 * OUT of the parent's row rather than added beside it: tokens subtracted field by field,
 * cost subtracted once the child's row has been priced. The ledger's total for the turn is
 * unchanged, and nothing is counted twice. If a producer ever reports less for a child than
 * it spent, the difference stays on the parent, which is where all of it used to be.
 *
 * Where the parent's figure is the main loop's alone (a resumed session with no stored
 * baseline; see `UsageCoverage`), the children were never in it, and their rows are pure
 * additions — spend that was previously missing from the ledger entirely.
 *
 * ## Who a child row belongs to
 *
 * `agentId` is the child's own `agents` row, found from the key it ran as. That is what makes
 * an agent-scoped budget limit see what the agent spent as a delegate. A child with no row of
 * ours — the SDK's built-in general-purpose, Explore or Plan agents — is charged to the
 * parent's agent, which is who spent it.
 *
 * Cost follows the parent's backend: zero on the Claude subscription (tokens only, like the
 * parent's row), and priced from the model catalogue on the gateway.
 *
 * ## When a row is written
 *
 * As soon as the child's card closes, not at the end of the turn (`./subagent-ledger.server`).
 * The budget check each later child passes reads the ledger, so a turn that fans out wave
 * after wave is checked against the waves that already finished.
 *
 * Pure, so the spec can pin the arithmetic. `./subagent-ledger.server` writes the rows.
 */

import type { SubagentUsage } from '../engine/tool-result-details'
import { spendTokenTotal } from '../engine/subagent-usage'
import type { EngineUsage, UsageCoverage } from '../engine/run-result'
import type { StreamBlock } from '../runs/runs.schema'

/** What one child's ledger row says. Mirrors the `logLlmUsage` input, minus the caller's ids. */
export type SubagentLedgerRow = {
	/** The delegation's tool_use id — the child's card, and the key for stamping its cost back. */
	toolUseId: string
	/** The agent key it ran as (`subagent_type`). */
	agentKey: string
	/** The `agents` row charged: the child's own, else the parent's. */
	agentId: string | null
	model: string
	tokensIn: number
	tokensOut: number
	tokensCacheWrite: number
	tokensCacheRead: number
	/** 0 on the Claude subscription; undefined to price it from the catalogue. */
	costOverride: number | undefined
	metadata: Record<string, unknown>
}

export type SubagentLedgerContext = {
	/** Whether the parent ran on the Claude CLI login. */
	claudeRun: boolean
	/** The parent's model — the child's too unless the SDK says it ended on another. */
	routedModel: string
	conversationId: string
	parentAgentId: string | null
	/** From `loadSubagentRoster`. */
	agentIdByKey: Readonly<Record<string, string>>
}

type SubagentStreamBlock = Extract<StreamBlock, { kind: 'subagent' }>

/** Where a row's tokens came from. See the module note. */
export type SubagentUsageBasis = 'model_calls' | 'final_call'

function spendOf(block: SubagentStreamBlock): { usage: SubagentUsage; basis: SubagentUsageBasis; modelCalls: number | null } | null {
	if (block.usage && spendTokenTotal(block.usage) !== null) {
		return { usage: block.usage, basis: 'model_calls', modelCalls: block.usage.modelCalls }
	}
	const details = block.details
	if (details?.kind === 'subagent' && details.status === 'completed' && details.usage) {
		return { usage: details.usage, basis: 'final_call', modelCalls: null }
	}
	return null
}

/**
 * The row for one child, or null when it spent nothing anyone reported: refused before it
 * started, or still launching. Whatever such a child spent stays in the parent's figure.
 */
export function subagentLedgerRow(block: StreamBlock, context: SubagentLedgerContext): SubagentLedgerRow | null {
	if (block.kind !== 'subagent') return null
	const spend = spendOf(block)
	if (!spend) return null
	const details = block.details?.kind === 'subagent' ? block.details : undefined
	// The key the SDK says it ran as, else the one the parent asked for.
	const agentKey = details?.agentType ?? block.agentName
	// The model: what the SDK resolved, else what the child's own calls said (on the Claude
	// login, where those are catalogue names), else the parent's.
	const model =
		details?.resolvedModel ?? (context.claudeRun ? block.usage?.model : null) ?? context.routedModel
	return {
		toolUseId: block.agentId,
		agentKey,
		agentId: context.agentIdByKey[agentKey] ?? context.parentAgentId,
		model,
		tokensIn: spend.usage.inputTokens,
		tokensOut: spend.usage.outputTokens,
		tokensCacheWrite: spend.usage.cacheCreationTokens,
		tokensCacheRead: spend.usage.cacheReadTokens,
		costOverride: context.claudeRun ? 0 : undefined,
		metadata: {
			conversationId: context.conversationId,
			toolUseId: block.agentId,
			subagentType: agentKey,
			sdkAgentId: details?.sdkAgentId ?? null,
			subscription: context.claudeRun,
			status: block.status ?? (block.success ? 'completed' : 'failed'),
			usageBasis: spend.basis,
			...(spend.modelCalls !== null ? { modelCalls: spend.modelCalls } : {}),
		},
	}
}

/** One row per child that spent something. See `subagentLedgerRow`. */
export function subagentLedgerRows(
	blocks: readonly StreamBlock[],
	context: SubagentLedgerContext,
): SubagentLedgerRow[] {
	return blocks.map((block) => subagentLedgerRow(block, context)).filter((row): row is SubagentLedgerRow => row !== null)
}

/**
 * The parent's own share of the turn once its children's rows are carved out of it.
 *
 * `childCostUsd` is what the children's rows were actually charged, so it is subtracted only
 * where the parent's cost already included them and is a figure rather than "price it
 * yourself" (`costUsd: null`). Everything is floored at zero: a child's calls can never
 * legitimately exceed the turn they were part of, and a ledger row must never go negative if
 * a producer ever reports more.
 */
export function carveParentUsage(
	parent: EngineUsage,
	coverage: UsageCoverage,
	children: readonly Pick<SubagentLedgerRow, 'tokensIn' | 'tokensOut' | 'tokensCacheWrite' | 'tokensCacheRead'>[],
	childCostUsd: number,
): EngineUsage {
	const sum = (pick: (row: (typeof children)[number]) => number) =>
		children.reduce((total, row) => total + Math.max(0, pick(row)), 0)
	const tokens = coverage.tokens
		? {
				inputTokens: Math.max(0, parent.inputTokens - sum((r) => r.tokensIn)),
				outputTokens: Math.max(0, parent.outputTokens - sum((r) => r.tokensOut)),
				cacheCreationTokens: Math.max(0, parent.cacheCreationTokens - sum((r) => r.tokensCacheWrite)),
				cacheReadTokens: Math.max(0, parent.cacheReadTokens - sum((r) => r.tokensCacheRead)),
			}
		: {
				inputTokens: parent.inputTokens,
				outputTokens: parent.outputTokens,
				cacheCreationTokens: parent.cacheCreationTokens,
				cacheReadTokens: parent.cacheReadTokens,
			}
	const costUsd =
		parent.costUsd !== null && coverage.cost ? Math.max(0, parent.costUsd - Math.max(0, childCostUsd)) : parent.costUsd
	return { ...tokens, costUsd }
}
