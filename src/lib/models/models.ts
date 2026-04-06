import { OpenRouter } from '@openrouter/sdk'
import { env } from '$env/dynamic/private'

export type ModelInfo = {
	id: string
	name: string
	description?: string | null
	contextLength: number | null
	promptPrice: string
	completionPrice: string
	modality?: string | null
	inputModalities?: string[]
	outputModalities?: string[]
	tokenizer?: string | null
	instructType?: string | null
	maxCompletionTokens?: number | null
	isModerated?: boolean | null
	supportedParameters?: string[]
	createdAt?: number | null
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
				description: 'Balanced reasoning and coding model for most chat and tool workflows.',
				contextLength: 200000,
				promptPrice: '0.000003',
				completionPrice: '0.000015',
				modality: 'text',
				inputModalities: ['text'],
				outputModalities: ['text'],
				tokenizer: 'claude',
				instructType: 'chat',
				maxCompletionTokens: 8192,
				isModerated: true,
				supportedParameters: ['temperature', 'max_tokens', 'tools'],
				createdAt: 1717200000,
			},
			{
				id: 'anthropic/claude-opus-4',
				name: 'Claude Opus 4',
				description: 'High-capability model optimized for complex reasoning and deep analysis.',
				contextLength: 200000,
				promptPrice: '0.000015',
				completionPrice: '0.000075',
				modality: 'text',
				inputModalities: ['text'],
				outputModalities: ['text'],
				tokenizer: 'claude',
				instructType: 'chat',
				maxCompletionTokens: 8192,
				isModerated: true,
				supportedParameters: ['temperature', 'max_tokens', 'tools'],
				createdAt: 1717200000,
			},
			{
				id: 'openai/gpt-4o-mini',
				name: 'GPT-4o Mini',
				description: 'Fast and cost-effective model for lightweight chat and automation tasks.',
				contextLength: 128000,
				promptPrice: '0.00000015',
				completionPrice: '0.0000006',
				modality: 'text',
				inputModalities: ['text'],
				outputModalities: ['text'],
				tokenizer: 'gpt',
				instructType: 'chat',
				maxCompletionTokens: 4096,
				isModerated: true,
				supportedParameters: ['temperature', 'max_tokens', 'tools'],
				createdAt: 1717200000,
			},
		]
	}

	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	const client = new OpenRouter({ apiKey: env.OPENROUTER_API_KEY })
	const response = await client.models.list()

	cachedModels = response.data
		.map((raw) => {
			const m = raw as {
				id: string
				name: string
				description?: string | null
				contextLength?: number | null
				created?: number | null
				pricing?: { prompt?: string; completion?: string }
				architecture?: {
					modality?: string | null
					inputModalities?: string[]
					outputModalities?: string[]
					tokenizer?: string | null
					instructType?: string | null
				}
				topProvider?: { maxCompletionTokens?: number | null; isModerated?: boolean | null }
				supportedParameters?: string[]
			}

			const promptPrice = Math.max(0, parseFloat(m.pricing?.prompt ?? '0') || 0)
			const completionPrice = Math.max(0, parseFloat(m.pricing?.completion ?? '0') || 0)

			return {
				id: m.id,
				name: m.name,
				description: m.description ?? null,
				contextLength: m.contextLength ?? null,
				promptPrice: promptPrice.toString(),
				completionPrice: completionPrice.toString(),
				modality: m.architecture?.modality ?? null,
				inputModalities: m.architecture?.inputModalities ?? [],
				outputModalities: m.architecture?.outputModalities ?? [],
				tokenizer: m.architecture?.tokenizer ?? null,
				instructType: m.architecture?.instructType ?? null,
				maxCompletionTokens: m.topProvider?.maxCompletionTokens ?? null,
				isModerated: m.topProvider?.isModerated ?? null,
				supportedParameters: m.supportedParameters ?? [],
				createdAt: m.created ?? null,
			}
		})
		.sort((a, b) => a.name.localeCompare(b.name))

	cacheTime = Date.now()
	return cachedModels
}
