/**
 * Writes the per-child ledger rows for a turn (#32) and works out what is left for the
 * parent's own row. The arithmetic, and why it is a carve-out rather than an addition, is in
 * `./subagent-ledger`.
 */

import { logLlmUsage } from '$lib/costs/usage'
import { logger } from '$lib/observability/logger'
import type { EngineUsage, UsageCoverage } from '$lib/engine/run-result'
import type { StreamBlock } from '$lib/runs/runs.schema'
import { carveParentUsage, subagentLedgerRows, type SubagentLedgerContext } from './subagent-ledger'

export type SubagentUsageRecord = {
	/** The parent's own share of the turn, for its `chat` row. */
	parentUsage: EngineUsage
	/** What the children's rows were charged, together. Add it back for the turn's total. */
	childCostUsd: number
}

/**
 * Log one `subagent` row per completed child, stamp each child's cost on its block (so the
 * persisted card can show it), and return the parent's remainder.
 *
 * A child row that fails to write is logged and left out, and the parent keeps that child's
 * share — the turn's total is what must survive a ledger hiccup, not the attribution.
 */
export async function recordSubagentUsage(
	input: SubagentLedgerContext & {
		blocks: StreamBlock[]
		usage: EngineUsage
		coverage: UsageCoverage
		userId: string
		runId: string
	},
): Promise<SubagentUsageRecord> {
	const rows = subagentLedgerRows(input.blocks, input)
	if (rows.length === 0) return { parentUsage: input.usage, childCostUsd: 0 }

	const written: typeof rows = []
	let childCostUsd = 0
	for (const row of rows) {
		try {
			const cost = parseFloat(
				await logLlmUsage({
					source: 'subagent',
					model: row.model,
					tokensIn: row.tokensIn,
					tokensOut: row.tokensOut,
					tokensCacheWrite: row.tokensCacheWrite,
					tokensCacheRead: row.tokensCacheRead,
					userId: input.userId,
					runId: input.runId,
					agentId: row.agentId,
					costOverride: row.costOverride,
					metadata: row.metadata,
				}),
			)
			const safeCost = Number.isFinite(cost) ? cost : 0
			childCostUsd += safeCost
			written.push(row)
			const block = input.blocks.find((b) => b.kind === 'subagent' && b.agentId === row.toolUseId)
			if (block && block.kind === 'subagent') block.costUsd = safeCost
		} catch (error) {
			logger.warn('[costs] subagent usage row failed; its share stays on the parent', {
				runId: input.runId,
				toolUseId: row.toolUseId,
				error: String(error),
			})
		}
	}

	return {
		parentUsage: carveParentUsage(input.usage, input.coverage, written, childCostUsd),
		childCostUsd,
	}
}
