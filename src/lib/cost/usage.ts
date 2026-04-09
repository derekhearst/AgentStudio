import { db } from '$lib/db.server'
import { llmUsage } from '$lib/cost/usage.schema'
import { listModels, type ModelInfo } from '$lib/models/models'

export type LlmUsageSource =
	| 'chat'
	| 'agent_planner'
	| 'agent_synthesis'
	| 'subagent'
	| 'titlegen'
	| 'memory_extract'
	| 'image_gen'

type LogInput = {
	source: LlmUsageSource
	model: string
	tokensIn: number
	tokensOut: number
	metadata?: Record<string, unknown>
	/** Override cost instead of calculating from model pricing (e.g. image gen returns cost directly) */
	costOverride?: number
}

let modelCache: ModelInfo[] | null = null
let modelCacheTime = 0
const MODEL_CACHE_TTL = 1000 * 60 * 60 // 1 hour

async function getModelPricing(modelId: string): Promise<{ promptPrice: number; completionPrice: number } | null> {
	if (!modelCache || Date.now() - modelCacheTime > MODEL_CACHE_TTL) {
		try {
			modelCache = await listModels()
			modelCacheTime = Date.now()
		} catch {
			return null
		}
	}

	const model = modelCache.find((m) => m.id === modelId)
	if (!model) return null

	return {
		promptPrice: parseFloat(model.promptPrice),
		completionPrice: parseFloat(model.completionPrice),
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

export async function logLlmUsage(input: LogInput): Promise<string> {
	let cost = '0'

	if (input.costOverride !== undefined) {
		cost = input.costOverride.toPrecision(15)
	} else {
		const pricing = await getModelPricing(input.model)
		if (pricing) {
			const calculated = calculateCost(input.tokensIn, input.tokensOut, pricing)
			cost = calculated.toPrecision(15)
		}
	}

	const [row] = await db
		.insert(llmUsage)
		.values({
			source: input.source,
			model: input.model,
			tokensIn: input.tokensIn,
			tokensOut: input.tokensOut,
			cost,
			metadata: input.metadata ?? {},
		})
		.returning({ id: llmUsage.id, cost: llmUsage.cost })

	return row.cost
}
