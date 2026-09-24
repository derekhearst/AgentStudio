/**
 * The chat route's two gateway checks (#9): refusing a model nothing here can run before a
 * turn is saved, and pricing a finished gateway turn. Kept out of `./gateway.server`, which
 * the engine's options import, because pricing reaches for the usage ledger's catalogue.
 */

import { getModelPricing } from '$lib/costs/usage'
import { engineModelBackend } from './gateway.server'
import { gatewayTurnCost, type GatewayTurnCost } from './gateway-cost'
import { isClaudeModel, normalizeModelId, unrunnableModelMessage } from './model-backend'
import type { EngineUsage } from './run-result'

/** The reason a send naming `model` must be refused, or null when it can run. */
export function refuseUnrunnableModel(model: string): string | null {
	return engineModelBackend(model) === 'unavailable' ? unrunnableModelMessage(model) : null
}

export type RunnableModelResolution =
	| { ok: true; model: string; replaced: string | null }
	| { ok: false; message: string }

/**
 * The model a send actually runs on.
 *
 * A conversation keeps the model it last ran with, and the page sends that back on every
 * message. When the stored model has since been retired — or was never an id the CLI runs,
 * like the `anthropic/claude-sonnet-4` catalogue slug older chats were created with —
 * refusing it would strand every such chat until someone noticed the picker. So a request
 * that is only repeating the conversation's stored model falls back to the settings
 * default, which the finished turn then saves on the conversation. Only a Claude id falls
 * back: a gateway model the gateway is not configured for keeps its refusal, which says how to
 * turn the gateway on, rather than silently moving the chat to another provider. A model the
 * user picked that differs from the stored one, and cannot run, is refused either way.
 */
export function resolveRunnableModel(input: {
	requested: string
	stored: string | null
	fallback: string
}): RunnableModelResolution {
	const refusal = refuseUnrunnableModel(input.requested)
	if (!refusal) return { ok: true, model: input.requested, replaced: null }
	const repeatsStored = input.stored != null && normalizeModelId(input.stored) === normalizeModelId(input.requested)
	if (repeatsStored && isClaudeModel(input.requested) && !refuseUnrunnableModel(input.fallback)) {
		return { ok: true, model: input.fallback, replaced: input.requested }
	}
	return { ok: false, message: refusal }
}

/**
 * This gateway turn's cost. `model` is the gateway's id for it, which for OpenRouter is the
 * catalogue's own id — the one the ledger row is recorded under too.
 */
export async function priceGatewayTurn(model: string, usage: EngineUsage): Promise<GatewayTurnCost> {
	const pricing = await getModelPricing(model).catch(() => null)
	return gatewayTurnCost(usage, pricing)
}

// Re-exported so the route takes both of its gateway ledger helpers from one module.
export { ledgerCostOverride } from './gateway-cost'
