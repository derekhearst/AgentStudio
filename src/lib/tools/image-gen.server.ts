/**
 * OpenRouter image generation.
 *
 * Maps friendly model aliases (`flux`, `sdxl`, `dall-e`) to the actual
 * provider IDs and POSTs to OpenRouter's `/api/v1/images/generations` endpoint.
 * Cost tracking happens at the executeTool dispatch site — this module is just
 * the API call.
 */

import { requireOpenRouterApiKey } from '$lib/server/config'

export type ImageModel = 'flux' | 'sdxl' | 'dall-e'
export type ImageSize = '256x256' | '512x512' | '1024x1024'

export type ImageResult = {
	url: string
	model: string
	size: string
	prompt: string
	cost: number
}

export const IMAGE_MODEL_MAP: Record<ImageModel, string> = {
	flux: 'black-forest-labs/flux-1-schnell',
	sdxl: 'stabilityai/stable-diffusion-xl-base-1.0',
	'dall-e': 'openai/dall-e-3',
}

export async function generateImage(
	prompt: string,
	model: ImageModel = 'flux',
	size: ImageSize = '1024x1024',
): Promise<ImageResult> {
	const apiKey = requireOpenRouterApiKey()

	const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: IMAGE_MODEL_MAP[model],
			prompt,
			n: 1,
			size,
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Image generation failed (${response.status}): ${text}`)
	}

	const data = (await response.json()) as {
		data?: Array<{ url?: string; b64_json?: string }>
		usage?: { total_cost?: number }
	}

	const imageUrl = data.data?.[0]?.url
	if (!imageUrl) {
		throw new Error('No image URL returned from generation API')
	}

	return {
		url: imageUrl,
		model: IMAGE_MODEL_MAP[model],
		size,
		prompt,
		cost: data.usage?.total_cost ?? 0,
	}
}
