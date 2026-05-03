import { db } from '$lib/db.server'
import { llmUsage, toolUsage } from '$lib/costs/usage.schema'
import { listModels, type ModelInfo } from '$lib/llm/models.server'

export type LlmUsageSource =
	| 'chat'
	| 'agent_planner'
	| 'agent_synthesis'
	| 'subagent'
	| 'automation'
	| 'evaluator'
	| 'titlegen'
	| 'image_gen'
	| 'memory_embed'
	| 'memory_extract'
	| 'memory_rerank'
	| 'memory_qa'

type LogInput = {
	source: LlmUsageSource
	model: string
	tokensIn: number
	tokensOut: number
	metadata?: Record<string, unknown>
	/** Override cost instead of calculating from model pricing (e.g. image gen returns cost directly) */
	costOverride?: number
	userId?: string | null
	runId?: string | null
	taskId?: string | null
	agentId?: string | null
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
			userId: input.userId ?? null,
			runId: input.runId ?? null,
			taskId: input.taskId ?? null,
			agentId: input.agentId ?? null,
			metadata: input.metadata ?? {},
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
	taskId?: string | null
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
			taskId: input.taskId ?? null,
			agentId: input.agentId ?? null,
			metadata: input.metadata ?? {},
		})
		.returning({ id: toolUsage.id, cost: toolUsage.cost })
	return row.cost
}
