/**
 * The Claude Code CLI's environment for a gateway run (#9).
 *
 * A gateway run is the same CLI pointed at an Anthropic-compatible endpoint instead of
 * Anthropic. What it needs on top of the ordinary allow-listed environment (`./engine-env`):
 *
 * - `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` — where to send requests, and the bearer
 *   token to send. For OpenRouter that is `https://openrouter.ai/api` and the OpenRouter key.
 * - `ANTHROPIC_API_KEY`, set to an empty string. OpenRouter's Claude Code and Agent SDK guides
 *   both say it must be explicitly empty: the CLI sends an API key as `x-api-key`, which can
 *   route the request to Anthropic directly instead of the gateway.
 * - Every model class pinned to the chosen model. The CLI makes calls the user never picked —
 *   the small "haiku" model for helper work, and whatever model a `Task` subagent names or
 *   inherits. Left alone, those still ask for a Claude id, which the gateway would serve as a
 *   paid Claude call (OpenRouter) or refuse (a gateway that has no Claude). Pinning them keeps
 *   the whole run on the model that was chosen and priced.
 *
 * What it must NOT have: the subscription login. `CLAUDE_CODE_OAUTH_TOKEN` is the long-lived
 * form of the Claude subscription; a gateway run does not use it, so it does not get it.
 * `CLAUDE_CONFIG_DIR` stays — it is where the CLI keeps session transcripts, and a resumed
 * turn reads its history from there.
 *
 * Nothing `ANTHROPIC_*` from the server's own environment crosses either: `buildEngineEnv`
 * drops that whole family, so the only `ANTHROPIC_*` a gateway run sees are the ones below.
 *
 * Pure, so the spec can check exactly what the CLI is given.
 */

import { buildEngineEnv } from './engine-env'

/** The model-class variables the CLI reads, each set to the gateway model. */
export const GATEWAY_MODEL_ENV_NAMES: readonly string[] = [
	'ANTHROPIC_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_FABLE_MODEL',
	// The older name for the helper model, still read by the CLI.
	'ANTHROPIC_SMALL_FAST_MODEL',
	'CLAUDE_CODE_SUBAGENT_MODEL',
]

/** Server variables a gateway run is not given even though an ordinary run is. */
const SUBSCRIPTION_ONLY_ENV_NAMES: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN']

export type GatewayConfig = { baseUrl: string; token: string }

export function buildGatewayEnv(input: {
	model: string
	gateway: GatewayConfig
	source: Record<string, string | undefined>
}): Record<string, string> {
	const base = buildEngineEnv(input.source)
	const dropped = new Set(SUBSCRIPTION_ONLY_ENV_NAMES)
	for (const name of Object.keys(base)) {
		if (dropped.has(name.toUpperCase())) delete base[name]
	}

	const models: Record<string, string> = {}
	for (const name of GATEWAY_MODEL_ENV_NAMES) models[name] = input.model

	return {
		...base,
		ANTHROPIC_BASE_URL: input.gateway.baseUrl,
		ANTHROPIC_AUTH_TOKEN: input.gateway.token,
		ANTHROPIC_API_KEY: '',
		...models,
	}
}

/**
 * The gateway settings from an environment, or null when either is missing or blank.
 * Blank counts as missing: docker-compose passes `${LLM_GATEWAY_URL:-}` through as an empty
 * string when the host leaves it unset.
 */
export function readGatewayConfig(source: Record<string, string | undefined>): GatewayConfig | null {
	const baseUrl = source.LLM_GATEWAY_URL?.trim()
	const token = source.LLM_GATEWAY_TOKEN?.trim()
	if (!baseUrl || !token) return null
	return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}
