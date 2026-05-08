import { OpenRouter } from '@openrouter/sdk'
import { requireOpenRouterApiKey } from '$lib/server/config'

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

/** Convenience capability flags derived from ModelInfo.inputModalities/outputModalities. */
export type ModelCapabilities = {
	supportsImage: boolean
	supportsAudioIn: boolean
	supportsAudioOut: boolean
	supportsVideo: boolean
	supportsFile: boolean
}

export function modelCapabilities(model: ModelInfo): ModelCapabilities {
	const inputs = new Set(model.inputModalities ?? [])
	const outputs = new Set(model.outputModalities ?? [])
	return {
		supportsImage: inputs.has('image'),
		supportsAudioIn: inputs.has('audio'),
		supportsAudioOut: outputs.has('audio') || outputs.has('speech'),
		supportsVideo: inputs.has('video'),
		supportsFile: inputs.has('file'),
	}
}

let cachedModels: ModelInfo[] | null = null
let cacheTime = 0
const CACHE_TTL = 1000 * 60 * 60 // 1 hour

export async function listModels(): Promise<ModelInfo[]> {
	if (cachedModels && Date.now() - cacheTime < CACHE_TTL) {
		return cachedModels
	}

	const client = new OpenRouter({ apiKey: requireOpenRouterApiKey() })
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
