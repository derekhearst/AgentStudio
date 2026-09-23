/**
 * The chat route's two gateway checks (#9): refusing a model nothing here can run before a
 * turn is saved, and pricing a finished gateway turn. Kept out of `./gateway.server`, which
 * the engine's options import, because pricing reaches for the usage ledger's catalogue.
 */

import { getModelPricing } from '$lib/costs/usage'
import { engineModelBackend } from './gateway.server'
import { gatewayTurnCost, type GatewayTurnCost } from './gateway-cost'
import { unrunnableModelMessage } from './model-backend'
import type { EngineUsage } from './run-result'

/** The reason a send naming `model` must be refused, or null when it can run. */
export function refuseUnrunnableModel(model: string): string | null {
	return engineModelBackend(model) === 'unavailable' ? unrunnableModelMessage(model) : null
}

/**
 * This gateway turn's cost. `model` is the gateway's id for it, which for OpenRouter is the
 * catalogue's own id — the one the ledger row is recorded under too.
 */
export async function priceGatewayTurn(model: string, usage: EngineUsage): Promise<GatewayTurnCost> {
	const pricing = await getModelPricing(model).catch(() => null)
	return gatewayTurnCost(usage, pricing)
}
