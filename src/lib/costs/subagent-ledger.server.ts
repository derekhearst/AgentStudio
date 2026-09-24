/**
 * Writes the per-child ledger rows for a turn (#32) and works out what is left for the
 * parent's own row. The arithmetic, and why it is a carve-out rather than an addition, is in
 * `./subagent-ledger`.
 *
 * A child's row is written the moment its card closes (`record`, which the engine calls
 * through `onSubagentDone`), not when the turn ends. The budget check a later child passes
 * reads the ledger, so a turn that fans out wave after wave meets its limit once the waves
 * already finished have spent it, rather than only on the next turn. `settle` runs once the
 * turn is over: it writes any child that was not booked yet and returns the parent's share.
 */

import { logLlmUsage } from '$lib/costs/usage'
import { logger } from '$lib/observability/logger'
import type { EngineUsage, UsageCoverage } from '$lib/engine/run-result'
import type { StreamBlock } from '$lib/runs/runs.schema'
import {
	carveParentUsage,
	subagentLedgerRow,
	type SubagentLedgerContext,
	type SubagentLedgerRow,
} from './subagent-ledger'

export type SubagentUsageRecord = {
	/** The parent's own share of the turn, for its `chat` row. */
	parentUsage: EngineUsage
	/** What the children's rows were charged, together. Add it back for the turn's total. */
	childCostUsd: number
}

export type SubagentLedgerInput = SubagentLedgerContext & { userId: string; runId: string }

export type SubagentLedger = {
	/**
	 * Book one child whose card has closed: write its row, if it spent anything, and stamp the
	 * row's cost on its block. Once per child; a second call for the same one does nothing.
	 */
	record(block: StreamBlock): Promise<void>
	/** The turn is over: book any child not booked yet, and return the parent's share. */
	settle(turn: { blocks: StreamBlock[]; usage: EngineUsage; coverage: UsageCoverage }): Promise<SubagentUsageRecord>
}

type Written = { row: SubagentLedgerRow; costUsd: number }

export function createSubagentLedger(input: SubagentLedgerInput): SubagentLedger {
	/** Delegation tool_use id → its row once written (null: nothing to write, or it failed). */
	const booked = new Map<string, Promise<Written | null>>()

	/**
	 * A row that fails to write is logged and left out, and the parent keeps that child's
	 * share: the turn's total is what must survive a ledger hiccup, not the attribution.
	 */
	const write = async (block: StreamBlock): Promise<Written | null> => {
		const row = subagentLedgerRow(block, input)
		if (!row) return null
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
			const costUsd = Number.isFinite(cost) ? cost : 0
			if (block.kind === 'subagent') block.costUsd = costUsd
			return { row, costUsd }
		} catch (error) {
			logger.warn('[costs] subagent usage row failed; its share stays on the parent', {
				runId: input.runId,
				toolUseId: row.toolUseId,
				error: String(error),
			})
			return null
		}
	}

	const record = (block: StreamBlock): Promise<Written | null> => {
		if (block.kind !== 'subagent') return Promise.resolve(null)
		let pending = booked.get(block.agentId)
		if (!pending) {
			pending = write(block)
			booked.set(block.agentId, pending)
		}
		return pending
	}

	return {
		async record(block) {
			await record(block)
		},
		async settle(turn) {
			for (const block of turn.blocks) await record(block)
			const written = (await Promise.all(booked.values())).filter((w): w is Written => w !== null)
			const childCostUsd = written.reduce((total, w) => total + w.costUsd, 0)
			return {
				parentUsage: carveParentUsage(
					turn.usage,
					turn.coverage,
					written.map((w) => w.row),
					childCostUsd,
				),
				childCostUsd,
			}
		},
	}
}

/**
 * Book every child of a finished turn at once and return the parent's remainder: `settle`
 * on a ledger nothing was recorded in yet.
 */
export async function recordSubagentUsage(
	input: SubagentLedgerInput & {
		blocks: StreamBlock[]
		usage: EngineUsage
		coverage: UsageCoverage
	},
): Promise<SubagentUsageRecord> {
	return createSubagentLedger(input).settle(input)
}
