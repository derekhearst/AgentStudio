import { OpenRouter } from '@openrouter/sdk'
import { env } from '$env/dynamic/private'

export type ModelInfo = {
	id: string
	name: string
	contextLength: number | null
	promptPrice: string
	completionPrice: string
}

let cachedModels: ModelInfo[] | null = null
let cacheTime = 0
const CACHE_TTL = 1000 * 60 * 60 // 1 hour

export async function listModels(): Promise<ModelInfo[]> {
	if (cachedModels && Date.now() - cacheTime < CACHE_TTL) {
		return cachedModels
	}

	if (env.E2E_MOCK_EXTERNALS === '1') {
		return [
			{
				id: 'anthropic/claude-sonnet-4',
				name: 'Claude Sonnet 4',
				contextLength: 200000,
				promptPrice: '0.000003',
				completionPrice: '0.000015',
			},
			{
				id: 'anthropic/claude-opus-4',
				name: 'Claude Opus 4',
				contextLength: 200000,
				promptPrice: '0.000015',
				completionPrice: '0.000075',
			},
			{
				id: 'openai/gpt-4o-mini',
				name: 'GPT-4o Mini',
				contextLength: 128000,
				promptPrice: '0.00000015',
				completionPrice: '0.0000006',
			},
		]
	}

	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	const client = new OpenRouter({ apiKey: env.OPENROUTER_API_KEY })
	const response = await client.models.list()

	cachedModels = response.data
		.map((m) => ({
			id: m.id,
			name: m.name,
			contextLength: m.contextLength,
			promptPrice: m.pricing.prompt,
			completionPrice: m.pricing.completion,
		}))
		.sort((a, b) => a.name.localeCompare(b.name))

	cacheTime = Date.now()
	return cachedModels
}
