/**
 * The deployment's gateway settings, read from the server environment (#9).
 *
 * `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` are both needed; with either missing the gateway
 * is off and only Claude models can run. The rules themselves are pure and live in
 * `./model-backend` and `./gateway-env`; this module only supplies the environment.
 *
 * Read from `process.env`, which `$lib/db.server` fills from `.env`, like the rest of the
 * server's settings (`$lib/server/config`) — not from `$env/dynamic/private`. That keeps the
 * modules that ask it importable outside SvelteKit: the `update_agent` tool handler checks a
 * model change here, and specs import that handler directly.
 */

import { error } from '@sveltejs/kit'
import { readGatewayConfig, type GatewayConfig } from './gateway-env'
import { checkRunnableModelChange, modelBackend, type EngineBackend, type RunnableModelChange } from './model-backend'

export function gatewayConfig(): GatewayConfig | null {
	return readGatewayConfig(process.env)
}

export function isGatewayConfigured(): boolean {
	return gatewayConfig() !== null
}

/** Where a run on `model` would go on this deployment. */
export function engineModelBackend(model: string): EngineBackend {
	return modelBackend(model, { gatewayConfigured: isGatewayConfigured() })
}

/**
 * Whether a save may change an engine model from `current` to `next` on this deployment, and
 * the id to store — `checkRunnableModelChange` with this deployment's gateway. For a caller
 * that answers with its own failure shape, such as a tool handler.
 */
export function runnableModelChange(next: string | undefined, current: string | null | undefined): RunnableModelChange {
	return checkRunnableModelChange(next, current, { gatewayConfigured: isGatewayConfigured() })
}

/**
 * `runnableModelChange` for a remote function: the id to store, or a 400 naming why the model
 * cannot run. Used by the default-model and agent-editor saves.
 */
export function requireRunnableModelChange(next: string | undefined, current: string | null | undefined): string | undefined {
	const change = runnableModelChange(next, current)
	if (!change.ok) error(400, change.message)
	return change.model
}
