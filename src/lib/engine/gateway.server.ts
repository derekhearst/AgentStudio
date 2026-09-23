/**
 * The deployment's gateway settings, read from the server environment (#9).
 *
 * `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` are both needed; with either missing the gateway
 * is off and only Claude models can run. The rules themselves are pure and live in
 * `./model-backend` and `./gateway-env`; this module only supplies the environment.
 */

import { error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { readGatewayConfig, type GatewayConfig } from './gateway-env'
import { modelBackend, normalizeModelId, unrunnableModelMessage, type EngineBackend } from './model-backend'

export function gatewayConfig(): GatewayConfig | null {
	return readGatewayConfig(env)
}

export function isGatewayConfigured(): boolean {
	return gatewayConfig() !== null
}

/** Where a run on `model` would go on this deployment. */
export function engineModelBackend(model: string): EngineBackend {
	return modelBackend(model, { gatewayConfigured: isGatewayConfigured() })
}

/**
 * The id to store for a model someone picked, or a 400 when nothing here can run it.
 *
 * For the saves that feed the engine — the default model, an agent's model. The picker
 * already offers only runnable models; this is the same rule for a request that did not
 * come through the picker, so an unrunnable model cannot be saved and then fail on the
 * first message.
 */
export function requireRunnableModel(model: string): string {
	if (engineModelBackend(model) === 'unavailable') error(400, unrunnableModelMessage(model))
	return normalizeModelId(model)
}

/**
 * `requireRunnableModel` for a save that may resend the model it already had.
 *
 * Only a change is checked. Editors send every field on save, and a model stored before this
 * rule — an agent left on a third-party model for its automations, say — must not stop its
 * owner saving an unrelated edit. Undefined (the field was not sent) passes through.
 */
export function requireRunnableModelChange(next: string | undefined, current: string | null | undefined): string | undefined {
	if (next === undefined) return undefined
	if (current != null && (next === current || normalizeModelId(next) === normalizeModelId(current))) return next
	return requireRunnableModel(next)
}
