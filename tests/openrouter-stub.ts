/**
 * A stand-in for OpenRouter inside the Playwright worker process.
 *
 * Specs that import server modules and call them directly — the memory miner, recall, the
 * reranker — reach OpenRouter through the global `fetch`: the embeddings client and the
 * cache-enabled chat path call it themselves, and the OpenRouter SDK's default fetcher looks
 * it up on every request. Swapping `globalThis.fetch` therefore stands in for OpenRouter
 * without touching the code under test, and records exactly what it was sent — which is
 * the point for specs about what leaves the process.
 *
 * CI has no model credential at all (`E2E_NO_MODEL_CREDENTIALS=1`), so without this every
 * such call would fail with a 401 there and succeed, at a cost, on a developer machine.
 * Anything that is not an OpenRouter URL goes to the real `fetch`.
 */

export const OPENROUTER_API = 'https://openrouter.ai/api/v1'

/** The vector width `memory_drawers.embedding` is declared with. */
export const STUB_EMBEDDING_DIM = 1536

export type OpenRouterCall = {
	/** Path under the API root: `/chat/completions`, `/embeddings`, `/models`. */
	path: string
	method: string
	headers: Record<string, string>
	body: Record<string, unknown> | null
}

type Handler<T> = (body: Record<string, unknown>) => T | Response | Promise<T | Response>

export type OpenRouterStubHandlers = {
	/** The assistant message text for a chat completion. Default: `{}`. */
	chat?: Handler<string>
	/** One vector per input. Default: `stubEmbedding(input)` for each. */
	embeddings?: Handler<number[][]>
}

export type OpenRouterStub = {
	calls: OpenRouterCall[]
	/** The calls made to one endpoint, in order. */
	callsTo(path: string): OpenRouterCall[]
	restore(): void
}

/** A deterministic unit vector for `text`, so equal inputs embed equally. */
export function stubEmbedding(text: string): number[] {
	let seed = 0
	for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) | 0
	const vector = Array.from({ length: STUB_EMBEDDING_DIM }, (_, i) => Math.sin(seed + i * 0.37))
	const norm = Math.hypot(...vector) || 1
	return vector.map((value) => value / norm)
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A chat completion the OpenRouter SDK's response schema accepts. */
export function chatCompletionResponse(content: string, model: string): Response {
	return json({
		id: 'gen-e2e-stub',
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model,
		system_fingerprint: 'e2e-stub',
		choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	})
}

/** The 400 OpenRouter answers a model id it does not know with. */
export function invalidModelResponse(model: string): Response {
	return json({ error: { code: 400, message: `${model} is not a valid model ID` } }, 400)
}

export function stubOpenRouter(handlers: OpenRouterStubHandlers = {}): OpenRouterStub {
	const realFetch = globalThis.fetch
	// `requireOpenRouterApiKey` refuses to run without one; the stub never checks it.
	process.env.OPENROUTER_API_KEY ||= 'e2e-openrouter-stub'
	const calls: OpenRouterCall[] = []

	const stubbed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request && init === undefined ? input : new Request(input, init)
		if (!request.url.startsWith(OPENROUTER_API)) return realFetch(input, init)

		const path = request.url.slice(OPENROUTER_API.length).split('?')[0]
		const text = request.method === 'GET' ? '' : await request.clone().text()
		const body = text ? (JSON.parse(text) as Record<string, unknown>) : null
		calls.push({ path, method: request.method, headers: Object.fromEntries(request.headers), body })

		// The pricing lookup behind `logLlmUsage`. Refused rather than answered empty: an empty
		// catalogue would be cached for an hour and outlive the stub in this worker process.
		if (path === '/models') return json({ error: { code: 503, message: 'e2e stub: no catalogue' } }, 503)
		if (path === '/chat/completions') {
			const model = String(body?.model ?? '')
			const answer = handlers.chat ? await handlers.chat(body ?? {}) : '{}'
			return answer instanceof Response ? answer : chatCompletionResponse(answer, model)
		}
		if (path === '/embeddings') {
			const inputs = (body?.input as string[] | undefined) ?? []
			const answer = handlers.embeddings ? await handlers.embeddings(body ?? {}) : inputs.map(stubEmbedding)
			if (answer instanceof Response) return answer
			return json({
				object: 'list',
				model: body?.model,
				data: answer.map((embedding, index) => ({ object: 'embedding', index, embedding })),
				usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
			})
		}
		return json({ error: { code: 404, message: `e2e stub has no handler for ${path}` } }, 404)
	}

	globalThis.fetch = stubbed as typeof fetch
	return {
		calls,
		callsTo: (path) => calls.filter((call) => call.path === path),
		restore: () => {
			globalThis.fetch = realFetch
		},
	}
}
