/**
 * Which backend runs a model, and the id the engine sends for it (#9).
 *
 * The engine has two backends:
 *
 *   subscription  A Claude model. The Claude Code CLI runs it on its own login, so it costs
 *                 nothing per token.
 *   gateway       Anything else. The CLI is pointed at an Anthropic-compatible gateway
 *                 (`LLM_GATEWAY_URL`, e.g. OpenRouter's Anthropic endpoint), which bills
 *                 per token.
 *
 * With no gateway configured a non-Claude model is `unavailable`: nothing can run it, so
 * the picker must not offer it and a send naming it is refused before anything is saved.
 *
 * Pure, with no `$env`, so the picker, the server and the specs all read the same rules.
 */

/** Models that run natively on the Claude Code CLI login. */
const CLAUDE_MODEL_PREFIXES = ['claude-', 'opus', 'sonnet', 'haiku']

/**
 * A dotted version pair inside a Claude id: `4.5` in `claude-haiku-4.5`, `3.7` in
 * `claude-3.7-sonnet`. OpenRouter writes versions with a dot; the CLI writes them with a
 * dash (`claude-haiku-4-5`) and does not recognise the dotted form.
 */
const DOTTED_VERSION = /(\d+)\.(\d+)/g

/**
 * The id the engine should send for `model`.
 *
 * - `anthropic/claude-haiku-4.5` → `claude-haiku-4-5`: the OpenRouter vendor prefix is
 *   stripped and a dotted version is written with a dash, which is the CLI's spelling.
 *   Conversations created before the engine migration carry OpenRouter ids, and so do
 *   rows picked from the OpenRouter catalogue; without this they either look like a
 *   third-party model or reach the CLI in a form it does not know.
 * - A bare Claude id is left as it is, apart from the same dot-to-dash rewrite.
 * - Every other id (`moonshotai/kimi-k2`, `openai/gpt-5`) is returned unchanged: it is the
 *   gateway's own id and the gateway is what reads it.
 */
export function normalizeModelId(model: string): string {
	const trimmed = model.trim()
	const slash = trimmed.indexOf('/')
	let bare = trimmed
	if (slash !== -1) {
		const vendor = trimmed.slice(0, slash).toLowerCase()
		if (vendor !== 'anthropic') return trimmed
		bare = trimmed.slice(slash + 1)
	}
	if (!/^claude-/i.test(bare)) return bare
	return bare.replace(DOTTED_VERSION, '$1-$2')
}

/** True when the Claude Code CLI serves `model` on its own login rather than via the gateway. */
export function isClaudeModel(model: string): boolean {
	const normalized = normalizeModelId(model).toLowerCase()
	return CLAUDE_MODEL_PREFIXES.some((p) => normalized.startsWith(p))
}

/** Where a run on this model goes. */
export type EngineBackend = 'subscription' | 'gateway' | 'unavailable'

export function modelBackend(model: string, options: { gatewayConfigured: boolean }): EngineBackend {
	if (isClaudeModel(model)) return 'subscription'
	return options.gatewayConfigured ? 'gateway' : 'unavailable'
}

/** The message a refused non-Claude model carries, shared by the route and the engine. */
export function gatewayNotConfiguredMessage(model: string): string {
	return `Model "${model}" needs an Anthropic-compatible gateway, but LLM_GATEWAY_URL / LLM_GATEWAY_TOKEN are not set.`
}
