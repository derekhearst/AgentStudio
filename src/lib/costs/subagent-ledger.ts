/**
 * Per-child cost attribution (#32): one `llm_usage` row for each delegated child, and the
 * parent's own row made smaller by the same amount.
 *
 * ## What the SDK reports for a child
 *
 * A child that completes answers its `Agent` call with a typed `AgentOutput`, which carries a
 * `usage` object (`SubagentDetails.usage`). Read the bundled CLI (2.1.278) and that object
 * turns out to be the usage of the child's LAST model call — not the sum of everything the
 * child spent. The SDK reports no per-child total anywhere else: the `result` message's
 * `modelUsage` covers every call of the turn, children included, but per model, not per child.
 *
 * So the figure a child row can carry is a floor on what the child cost: its final call,
 * exactly. What makes that safe to write is the other half —
 *
 * ## The turn's total stays exact
 *
 * The parent's row is the turn's measured usage (`./run-result`), and when that figure is
 * read from `modelUsage` it already includes every child. A child row is therefore carved
 * OUT of the parent's row rather than added beside it: tokens subtracted field by field,
 * cost subtracted once the child's row has been priced. The ledger's total for the turn is
 * unchanged — nothing is counted twice — and the part of a child's spend its final call does
 * not cover stays on the parent, which is where all of it used to be.
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
 * Pure, so the spec can pin the arithmetic. `./subagent-ledger.server` writes the rows.
 */

import type { SubagentDetails, SubagentUsage } from '../engine/tool-result-details'
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

function completedDetails(block: SubagentStreamBlock): (SubagentDetails & { usage: SubagentUsage }) | null {
	const details = block.details
	if (!details || details.kind !== 'subagent' || details.status !== 'completed' || !details.usage) return null
	return details as SubagentDetails & { usage: SubagentUsage }
}

/**
 * One row per child that completed and reported usage. A refused, failed or stopped child
 * reported nothing, so it has no row; whatever it spent is still in the parent's figure.
 */
export function subagentLedgerRows(
	blocks: readonly StreamBlock[],
	context: SubagentLedgerContext,
): SubagentLedgerRow[] {
	const rows: SubagentLedgerRow[] = []
	for (const block of blocks) {
		if (block.kind !== 'subagent') continue
		const details = completedDetails(block)
		if (!details) continue
		// The key the SDK says it ran as, else the one the parent asked for.
		const agentKey = details.agentType ?? block.agentName
		rows.push({
			toolUseId: block.agentId,
			agentKey,
			agentId: context.agentIdByKey[agentKey] ?? context.parentAgentId,
			model: details.resolvedModel ?? context.routedModel,
			tokensIn: details.usage.inputTokens,
			tokensOut: details.usage.outputTokens,
			tokensCacheWrite: details.usage.cacheCreationTokens,
			tokensCacheRead: details.usage.cacheReadTokens,
			costOverride: context.claudeRun ? 0 : undefined,
			metadata: {
				conversationId: context.conversationId,
				toolUseId: block.agentId,
				subagentType: agentKey,
				sdkAgentId: details.sdkAgentId,
				subscription: context.claudeRun,
				// See the module note: the SDK reports the child's final model call.
				usageBasis: 'final_call',
			},
		})
	}
	return rows
}

/**
 * The parent's own share of the turn once its children's rows are carved out of it.
 *
 * `childCostUsd` is what the children's rows were actually charged, so it is subtracted only
 * where the parent's cost already included them and is a figure rather than "price it
 * yourself" (`costUsd: null`). Everything is floored at zero: a child's final call can never
 * legitimately exceed the turn it was part of, and a ledger row must never go negative if a
 * producer ever reports one that does.
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
