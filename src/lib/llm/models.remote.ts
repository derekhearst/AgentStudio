import { query } from '$app/server'
import { listModels } from '$lib/llm/models.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { logger } from '$lib/observability/logger'
import { isGatewayConfigured } from '$lib/engine/gateway.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { buildEngineModelList, type EngineModelList } from '$lib/llm/engine-models'
import { listGatewayModelIds } from '$lib/llm/gateway-models.server'

/**
 * The model list for the picker.
 *
 * Failure here must never take a page down. `RecentChats.svelte` awaits this inside a
 * `$derived`, and it renders in the sidebar of *every* page — so before this catch, any
 * failure reaching OpenRouter (an outage, a DNS blip, a network policy that does not allow
 * the host) turned into `500 Internal Error` on `/` and on every `/chat/[id]`. A
 * self-hosted app whose own chat page is unreachable because a third-party catalogue is
 * unreachable is worse than one with an empty model dropdown.
 *
 * CI cannot catch this: OpenRouter's model catalogue answers unauthenticated, so a runner
 * with a placeholder key still gets a 200 and the failure path never runs. It reproduces
 * the moment the host itself is unreachable.
 *
 * `ModelSelector` already starts from `[]` and treats the list as state, so an empty
 * result degrades to "no alternatives offered" rather than breaking. The conversation keeps
 * the model it already has — `conversations.model` is a column, not something derived from
 * this list.
 *
 * Deliberately NOT applied inside `listModels` itself: `$lib/costs/usage` uses it to price
 * a run, and there an empty list would silently bill zero instead of failing loudly.
 * The UI can degrade; the ledger cannot.
 */
export const getAvailableModels = query(async () => {
	// Outside the try on purpose: a missing session is a refusal, not a catalogue outage to
	// paper over with an empty list.
	requireAuthenticatedRequestUser()
	try {
		return await listModels()
	} catch (error) {
		logger.warn('[llm/models] model catalogue unavailable; serving an empty picker', {
			error: error instanceof Error ? error.message : String(error),
		})
		return []
	}
})

/**
 * The models the chat engine can run, for the engine's pickers: the chat composer, the agent
 * editor and the default-model setting (#9). See `./engine-models` for the rules.
 *
 * `getAvailableModels` stays the whole catalogue: the transcription picker and the other
 * OpenRouter-only features can use any of it, the engine cannot.
 *
 * Degrades the same way, to an empty list, and each source on its own — an unreachable
 * catalogue still leaves the gateway's models and the saved default to pick from.
 */
export const getEngineModels = query(async (): Promise<EngineModelList> => {
	const user = requireAuthenticatedRequestUser()
	const gatewayConfigured = isGatewayConfigured()
	const warn = (source: string) => (error: unknown) => {
		logger.warn(`[llm/models] ${source} unavailable for the engine picker`, {
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
	const [catalogue, gatewayModelIds, settings] = await Promise.all([
		listModels().catch(warn('model catalogue')),
		gatewayConfigured ? listGatewayModelIds() : Promise.resolve(null),
		getOrCreateSettings(user.id).catch(warn('settings')),
	])
	return {
		gatewayConfigured,
		models: buildEngineModelList({
			catalogue: catalogue ?? [],
			gatewayConfigured,
			gatewayModelIds,
			pinned: settings?.defaultModel ? [settings.defaultModel] : [],
		}),
	}
})
