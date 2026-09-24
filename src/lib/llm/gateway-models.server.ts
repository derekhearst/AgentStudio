/**
 * What the configured gateway says it serves (#9).
 *
 * `GET {LLM_GATEWAY_URL}/v1/models` with the gateway token. For OpenRouter's Anthropic
 * endpoint (`https://openrouter.ai/api`) that is OpenRouter's own model list; LiteLLM serves
 * the same path with the models it was configured with. Either way the answer is
 * `{ data: [{ id }] }`, and the ids are what the gateway accepts as a model name.
 *
 * The engine picker offers a gateway model only if it is in this list, so a model the gateway
 * does not serve cannot be picked. A failed request is logged and treated as "no gateway
 * models" rather than guessed at, and retried after a minute rather than on every picker open.
 */

import { gatewayConfig } from '$lib/engine/gateway.server'
import { parseGatewayModelIds } from '$lib/llm/engine-models'
import { logger } from '$lib/observability/logger'

const SUCCESS_TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

type CacheEntry = { baseUrl: string; ids: string[] | null; expiresAt: number }
let cache: CacheEntry | null = null

/** The gateway's model ids, or null when the gateway is off or could not be asked. */
export async function listGatewayModelIds(): Promise<string[] | null> {
	const gateway = gatewayConfig()
	if (!gateway) return null

	const now = Date.now()
	if (cache && cache.baseUrl === gateway.baseUrl && cache.expiresAt > now) return cache.ids

	let ids: string[] | null = null
	try {
		const response = await fetch(`${gateway.baseUrl}/v1/models`, {
			headers: { authorization: `Bearer ${gateway.token}`, accept: 'application/json' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		ids = parseGatewayModelIds(await response.json())
	} catch (error) {
		// Neither the token nor the URL is logged: Settings → System treats both as values it
		// never shows, and a URL can carry a secret path.
		logger.warn('[llm/gateway-models] gateway model list unavailable; offering no gateway models', {
			error: error instanceof Error ? error.message : String(error),
		})
	}

	cache = { baseUrl: gateway.baseUrl, ids, expiresAt: now + (ids ? SUCCESS_TTL_MS : FAILURE_TTL_MS) }
	return ids
}
