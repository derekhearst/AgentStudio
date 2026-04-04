import { env } from '$env/dynamic/private'

type ImageModel = 'flux' | 'sdxl' | 'dall-e'
type ImageSize = '256x256' | '512x512' | '1024x1024'

type ImageResult = {
	url: string
	model: string
	size: string
	prompt: string
	cost: number
}

const MODEL_MAP: Record<ImageModel, string> = {
	flux: 'black-forest-labs/flux-1-schnell',
	sdxl: 'stabilityai/stable-diffusion-xl-base-1.0',
	'dall-e': 'openai/dall-e-3',
}

const MOCK_EXTERNALS = env.E2E_MOCK_EXTERNALS === '1'

export async function generateImage(
	prompt: string,
	model: ImageModel = 'flux',
	size: ImageSize = '1024x1024',
): Promise<ImageResult> {
	if (MOCK_EXTERNALS) {
		return {
			url: 'https://placehold.co/1024x1024/333/fff?text=MOCK+IMAGE',
			model: MODEL_MAP[model],
			size,
			prompt,
			cost: 0,
		}
	}

	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	// Use OpenRouter's image generation endpoint
	const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: MODEL_MAP[model],
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
		model: MODEL_MAP[model],
		size,
		prompt,
		cost: data.usage?.total_cost ?? 0,
	}
}
