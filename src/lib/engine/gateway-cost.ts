/**
 * What a gateway turn cost (#9).
 *
 * A Claude run is on the subscription and records $0. A gateway run is billed per token, and
 * the figure the SDK reports for it cannot be used: the CLI prices a model by looking its id
 * up in its own table of Claude prices, and for an id it has no row for (every gateway model)
 * `costUSD` is "a guess at the default model's rate" — the SDK's own words, flagged with
 * `costBasis: 'unknown'`. A Kimi turn would be logged at an Opus or Sonnet price.
 *
 * So a gateway turn is priced here, from the same OpenRouter catalogue the rest of the ledger
 * uses, over the turn's own tokens (`./run-result` has already taken the earlier turns of the
 * session out). Token counts follow the Anthropic convention the CLI reports in: input tokens
 * exclude cached ones, which are counted separately as cache writes and cache reads. Each is
 * priced at the catalogue's cache price when it lists one, otherwise at the prompt price.
 *
 * Only when the catalogue has no price for the model at all — a model only the gateway knows,
 * such as a local one behind LiteLLM — does the SDK's estimate stand in, marked as such.
 *
 * Pure, so the spec can check the arithmetic.
 */

import type { EngineUsage } from './run-result'

export type GatewayPricing = {
	promptPrice: number
	completionPrice: number
	cacheReadPrice?: number | null
	cacheWritePrice?: number | null
}

/**
 * Where a gateway turn's dollar figure came from: the catalogue, the CLI's own estimate
 * (no catalogue price), or neither (no catalogue price and no estimate — recorded as $0).
 */
export type GatewayCostBasis = 'catalogue' | 'cli-estimate' | 'unpriced'

export type GatewayTurnCost = { costUsd: number; costBasis: GatewayCostBasis }

const price = (value: number | null | undefined, fallback: number) =>
	typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback

export function gatewayTurnCost(usage: EngineUsage, pricing: GatewayPricing | null): GatewayTurnCost {
	if (pricing) {
		const prompt = price(pricing.promptPrice, 0)
		const completion = price(pricing.completionPrice, 0)
		const costUsd =
			usage.inputTokens * prompt +
			usage.cacheCreationTokens * price(pricing.cacheWritePrice, prompt) +
			usage.cacheReadTokens * price(pricing.cacheReadPrice, prompt) +
			usage.outputTokens * completion
		return { costUsd, costBasis: 'catalogue' }
	}
	if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
		return { costUsd: Math.max(0, usage.costUsd), costBasis: 'cli-estimate' }
	}
	return { costUsd: 0, costBasis: 'unpriced' }
}

/**
 * The `costOverride` a chat turn hands the usage ledger.
 *
 * - No gateway cost (a subscription turn): 0 — there is no per-token price to record.
 * - A gateway turn with a price: that price.
 * - An unpriced gateway turn: no override, so the ledger does its own lookup, finds no price
 *   either, and records the row the way it records every unpriced call — a zero cost marked
 *   `unpriced` with the reason, and a warning in the log — rather than as a silent $0.
 */
export function ledgerCostOverride(cost: GatewayTurnCost | null): number | undefined {
	if (!cost) return 0
	return cost.costBasis === 'unpriced' ? undefined : cost.costUsd
}
