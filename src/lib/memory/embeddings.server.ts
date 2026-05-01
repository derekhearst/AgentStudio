/**
 * OpenRouter-backed embeddings client.
 *
 * Uses the OpenAI-compatible /embeddings endpoint exposed by OpenRouter.
 * Default model: text-embedding-3-small (1536 dims) — must match the pgvector
 * column dimension declared in src/lib/memory/memory.schema.ts.
 */

import { env } from '$env/dynamic/private'
import { logLlmUsage } from '$lib/cost/usage'

export const EMBEDDING_DIM = 1536
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings'

const MAX_BATCH = 64
const MAX_RETRIES = 4

type EmbedOptions = {
	model?: string
	logSource?: 'memory_embed'
	metadata?: Record<string, unknown>
}

type EmbeddingResponse = {
	data: Array<{ embedding: number[]; index: number }>
	usage?: { prompt_tokens?: number; total_tokens?: number }
	model?: string
}

async function callEmbeddings(model: string, input: string[]): Promise<EmbeddingResponse> {
	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	let attempt = 0
	let lastError: unknown = null
	while (attempt < MAX_RETRIES) {
		const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model, input }),
		})

		if (response.ok) {
			return (await response.json()) as EmbeddingResponse
		}

		// 429 / 5xx -> retry with backoff
		if (response.status === 429 || response.status >= 500) {
			lastError = new Error(`Embeddings request failed: ${response.status} ${response.statusText}`)
			const backoff = Math.min(2000 * 2 ** attempt, 16_000)
			await new Promise((r) => setTimeout(r, backoff))
			attempt += 1
			continue
		}

		const body = await response.text()
		throw new Error(`Embeddings request failed: ${response.status} ${response.statusText}: ${body}`)
	}

	throw lastError ?? new Error('Embeddings request exhausted retries')
}

export async function embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
	if (texts.length === 0) return []
	const model = options.model ?? DEFAULT_EMBEDDING_MODEL
	const out: number[][] = new Array(texts.length)

	for (let start = 0; start < texts.length; start += MAX_BATCH) {
		const slice = texts.slice(start, start + MAX_BATCH)
		const result = await callEmbeddings(model, slice)
		for (const item of result.data) {
			out[start + item.index] = item.embedding
		}

		const tokensIn = result.usage?.prompt_tokens ?? result.usage?.total_tokens ?? 0
		await logLlmUsage({
			source: 'memory_embed',
			model,
			tokensIn,
			tokensOut: 0,
			metadata: { batchSize: slice.length, ...(options.metadata ?? {}) },
		}).catch((error) => {
			console.warn('[memory] failed to log embedding usage', error)
		})
	}

	return out
}

/** Embed a single string. */
export async function embedOne(text: string, options: EmbedOptions = {}): Promise<number[]> {
	const [vector] = await embed([text], options)
	return vector
}

/** Format a JS number array as a pgvector string literal: "[0.1,0.2,...]". */
export function toPgVector(values: number[]): string {
	return `[${values.join(',')}]`
}
