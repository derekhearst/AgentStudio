import { getModelForTier } from '$lib/openrouter.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { db } from '$lib/db.server'
import { llmUsage } from '$lib/cost/usage.schema'
import { sql, gte } from 'drizzle-orm'

type RoutingContext = {
	content: string
	conversationDepth?: number
	hasToolCalls?: boolean
	explicitModel?: string
}

type RoutingResult = {
	model: string
	tier: 'fast' | 'powerful' | 'cheap'
	reason: string
	budgetDowngraded: boolean
}

function classifyComplexity(ctx: RoutingContext): 'fast' | 'powerful' | 'cheap' {
	const content = ctx.content.toLowerCase()
	const len = content.length

	// Explicit code/reasoning signals → powerful
	const powerfulSignals = [
		/\b(implement|refactor|debug|architect|design|analyze|explain in detail)\b/,
		/\b(write.*code|create.*function|build.*component|fix.*bug)\b/,
		/\b(compare|contrast|trade.?offs?|pros?\s+and\s+cons?)\b/,
		/```[\s\S]*```/,
	]
	if (powerfulSignals.some((r) => r.test(content))) return 'powerful'

	// Deep conversation context → powerful
	if ((ctx.conversationDepth ?? 0) > 8) return 'powerful'

	// Long messages are likely complex
	if (len > 1000) return 'powerful'

	// Short simple queries → cheap
	const cheapSignals = [
		/^(what|who|when|where|how much|yes|no|ok|thanks|hi|hello)\b/,
		/\b(translate|summarize|tldr|define)\b/,
	]
	if (len < 200 && cheapSignals.some((r) => r.test(content))) return 'cheap'

	// Default → fast (balanced)
	return 'fast'
}

async function getSpendToday(): Promise<number> {
	const startOfDay = new Date()
	startOfDay.setHours(0, 0, 0, 0)

	const [result] = await db
		.select({
			total: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)`,
		})
		.from(llmUsage)
		.where(gte(llmUsage.createdAt, startOfDay))

	return parseFloat(result?.total ?? '0')
}

async function getSpendThisMonth(): Promise<number> {
	const startOfMonth = new Date()
	startOfMonth.setDate(1)
	startOfMonth.setHours(0, 0, 0, 0)

	const [result] = await db
		.select({
			total: sql<string>`coalesce(sum(${llmUsage.cost}::numeric), 0)`,
		})
		.from(llmUsage)
		.where(gte(llmUsage.createdAt, startOfMonth))

	return parseFloat(result?.total ?? '0')
}

export async function routeModel(ctx: RoutingContext): Promise<RoutingResult> {
	// If the user explicitly chose a model, use it
	if (ctx.explicitModel) {
		return {
			model: ctx.explicitModel,
			tier: 'fast',
			reason: 'User-selected model',
			budgetDowngraded: false,
		}
	}

	const settings = await getOrCreateSettings()
	const tier = classifyComplexity(ctx)
	let model = getModelForTier(tier)
	let budgetDowngraded = false
	let reason = `Classified as ${tier}`

	// Budget-aware downgrade
	const budget = settings.budgetConfig
	if (budget.dailyLimit || budget.monthlyLimit) {
		const [dailySpend, monthlySpend] = await Promise.all([
			budget.dailyLimit ? getSpendToday() : Promise.resolve(0),
			budget.monthlyLimit ? getSpendThisMonth() : Promise.resolve(0),
		])

		const dailyRatio = budget.dailyLimit ? dailySpend / budget.dailyLimit : 0
		const monthlyRatio = budget.monthlyLimit ? monthlySpend / budget.monthlyLimit : 0
		const maxRatio = Math.max(dailyRatio, monthlyRatio)

		if (maxRatio >= 1.0) {
			// At or over budget — force cheapest
			model = getModelForTier('cheap')
			budgetDowngraded = true
			reason = `Budget limit reached (${Math.round(maxRatio * 100)}%) — forced cheap model`
		} else if (maxRatio >= 0.8 && tier === 'powerful') {
			// Near budget — downgrade powerful to fast
			model = getModelForTier('fast')
			budgetDowngraded = true
			reason = `Near budget (${Math.round(maxRatio * 100)}%) — downgraded from powerful to fast`
		}
	}

	return { model, tier, reason, budgetDowngraded }
}



