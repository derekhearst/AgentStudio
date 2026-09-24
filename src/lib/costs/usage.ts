import { db } from '$lib/db.server'
import { llmUsage, toolUsage } from '$lib/costs/usage.schema'
import { listModels } from '$lib/llm/models.server'
import { createModelPriceTable, createUnpricedWarner, type ModelPrice } from '$lib/costs/model-pricing'

export type LlmUsageSource =
	| 'chat'
	| 'agent_planner'
	| 'agent_synthesis'
	| 'subagent'
	| 'automation'
	// #33 — the cheap yes/no call a `model_question` monitor makes on each check. Its own
	// source so monitor spend is separable from scheduled automation spend in the ledger.
	| 'monitor'
	| 'evaluator'
	| 'titlegen'
	| 'image_gen'
	| 'memory_embed'
	| 'memory_extract'
	| 'memory_rerank'
	| 'memory_qa'
	| 'tts'
	| 'video_gen'

type LogInput = {
	source: LlmUsageSource
	model: string
	tokensIn: number
	tokensOut: number
	/**
	 * Anthropic prompt-caching breakdown. tokensIn is the gross prompt token count (which already
	 * includes any cached portion); these fields isolate the cached pieces for cost analysis. Zero
	 * on non-Anthropic providers.
	 */
	tokensCacheWrite?: number
	tokensCacheRead?: number
	metadata?: Record<string, unknown>
	/** Override cost instead of calculating from model pricing (e.g. image gen returns cost directly) */
	costOverride?: number
	userId?: string | null
	runId?: string | null
	agentId?: string | null
}

const priceTable = createModelPriceTable(listModels)
const warnUnpriced = createUnpricedWarner()

/**
 * A model's per-token prices from the OpenRouter catalogue, cache prices included, or null
 * when there is no price to be had (the catalogue never loaded, or does not list the model).
 * For the gateway's per-turn pricing (`$lib/engine/gateway-run.server`), which prices cached
 * prompt tokens separately. Served from the same table as the ledger, so a failed catalogue
 * refresh keeps pricing from the previous copy here too.
 */
export async function getModelPricing(modelId: string): Promise<ModelPrice | null> {
	const pricing = await priceTable.lookup(modelId)
	if (pricing.status !== 'priced') return null
	return {
		promptPrice: pricing.promptPrice,
		completionPrice: pricing.completionPrice,
		cacheReadPrice: pricing.cacheReadPrice ?? null,
		cacheWritePrice: pricing.cacheWritePrice ?? null,
	}
}

export function calculateCost(
	tokensIn: number,
	tokensOut: number,
	pricing: { promptPrice: number; completionPrice: number },
): number {
	// OpenRouter prices are per-token (not per-1K); clamp negatives to 0
	const prompt = Math.max(0, pricing.promptPrice)
	const completion = Math.max(0, pricing.completionPrice)
	return tokensIn * prompt + tokensOut * completion
}

/**
 * Write one row to the LLM usage ledger and return its cost.
 *
 * The cost is `costOverride` when the caller has the real figure, otherwise tokens times the
 * catalogue price. When there is no price to be had — the catalogue has never loaded, or it
 * does not list the model — the row is written with a zero cost and
 * `metadata.unpriced` set to the reason, and a warning is logged. The zero is then a known
 * gap the cost view can count, not a silent claim that the call was free.
 */
export async function logLlmUsage(input: LogInput): Promise<string> {
	let cost = '0'
	let metadata = input.metadata ?? {}

	if (input.costOverride !== undefined) {
		cost = input.costOverride.toPrecision(15)
	} else {
		const pricing = await priceTable.lookup(input.model)
		if (pricing.status === 'priced') {
			const calculated = calculateCost(input.tokensIn, input.tokensOut, pricing)
			cost = calculated.toPrecision(15)
		} else {
			metadata = { ...metadata, unpriced: pricing.reason }
			warnUnpriced({ model: input.model, source: input.source, reason: pricing.reason })
		}
	}

	const [row] = await db
		.insert(llmUsage)
		.values({
			source: input.source,
			model: input.model,
			tokensIn: input.tokensIn,
			tokensOut: input.tokensOut,
			tokensCacheWrite: input.tokensCacheWrite ?? 0,
			tokensCacheRead: input.tokensCacheRead ?? 0,
			cost,
			userId: input.userId ?? null,
			runId: input.runId ?? null,
			agentId: input.agentId ?? null,
			metadata,
		})
		.returning({ id: llmUsage.id, cost: llmUsage.cost })

	return row.cost
}

export type ToolUnitType = 'credit' | 'second' | 'call' | 'mb'

export type LogToolUsageInput = {
	toolName: string
	provider?: string | null
	unitType: ToolUnitType
	units: number
	/** Direct cost in USD. If omitted, computed as `units * costPerUnit`. */
	cost?: number
	/** Cost per unit in USD; ignored if `cost` is supplied. */
	costPerUnit?: number
	userId?: string | null
	runId?: string | null
	agentId?: string | null
	metadata?: Record<string, unknown>
}

export async function logToolUsage(input: LogToolUsageInput): Promise<string> {
	const computedCost = input.cost ?? Math.max(0, input.units * (input.costPerUnit ?? 0))
	const costStr = computedCost.toPrecision(15)
	const [row] = await db
		.insert(toolUsage)
		.values({
			toolName: input.toolName,
			provider: input.provider ?? null,
			unitType: input.unitType,
			units: input.units.toPrecision(15),
			cost: costStr,
			userId: input.userId ?? null,
			runId: input.runId ?? null,
			agentId: input.agentId ?? null,
			metadata: input.metadata ?? {},
		})
		.returning({ id: toolUsage.id, cost: toolUsage.cost })
	return row.cost
}
