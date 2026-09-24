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
 * So is a Claude id the subscription cannot run — a retired model, or a catalogue slug that
 * is not an Anthropic id at all (`claude-sonnet-4`). Claude never goes to the paid gateway.
 *
 * Pure, with no `$env`, so the picker, the server and the specs all read the same rules.
 */

/** Models that run natively on the Claude Code CLI login. */
const CLAUDE_MODEL_PREFIXES = ['claude-', 'opus', 'sonnet', 'haiku']

/** The CLI's own aliases, which it resolves to a current model itself. */
const CLI_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'best', 'opusplan'])

/** The CLI's 1M-context suffix: `claude-sonnet-4-5[1m]`, `opus[1m]`. */
const ONE_MILLION_SUFFIX = /\[1m\]$/i

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
 * - A Claude id or CLI alias is written in lower case, as the CLI spells every one of them:
 *   `ANTHROPIC/Claude-Sonnet-5` is `claude-sonnet-5`, `Opus` is `opus`.
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
	const lower = bare.toLowerCase()
	if (lower.startsWith('claude-')) return lower.replace(DOTTED_VERSION, '$1-$2')
	if (CLI_MODEL_ALIASES.has(lower.replace(ONE_MILLION_SUFFIX, ''))) return lower
	return bare
}

/**
 * True when `model` names Claude, in either spelling or as a CLI alias. Such a model is the
 * subscription's to run, never the gateway's — but only one `isSubscriptionModel` accepts
 * can actually run.
 *
 * Every alias counts, not only the ones that begin like a family name: `fable` and `best`
 * are Claude too, and without this a gateway would be handed them as paid calls.
 */
export function isClaudeModel(model: string): boolean {
	const normalized = normalizeModelId(model).toLowerCase()
	if (CLI_MODEL_ALIASES.has(normalized.replace(ONE_MILLION_SUFFIX, ''))) return true
	return CLAUDE_MODEL_PREFIXES.some((p) => normalized.startsWith(p))
}

/**
 * The Claude models the subscription can run, under the id the CLI takes for each.
 *
 * Taken from the model table of the Claude Code CLI this app bundles
 * (`@anthropic-ai/claude-agent-sdk` 0.3.278, CLI 2.1.278), less the models that table dates
 * as retired on Anthropic's own API: the Claude 3 generation, Claude Sonnet 4 and Opus 4
 * (retired 15 June 2026), and Opus 4.1 (retired 5 August 2026, which the CLI now quietly
 * remaps to the latest Opus). Mythos is left out too: it is offered only to Project
 * Glasswing members, not on a subscription.
 *
 * OpenRouter's catalogue cannot be the source for this. It keeps listing Claude models after
 * Anthropic retires them, and under slugs that are not Anthropic ids at all:
 * `anthropic/claude-sonnet-4` is `claude-sonnet-4-0` to the CLI, and `claude-sonnet-4` is
 * nothing. When an SDK upgrade brings a CLI that knows a new model, add it here — until
 * then the pickers do not offer it.
 *
 * One exception: `claude-opus-5-5` is newer than the bundled CLI's table but is in daily use
 * on this instance, and the CLI passes an id it has no table entry for straight through to
 * the API, which serves it. It is listed on the operator's word; drop the note once an SDK
 * upgrade brings a CLI whose table has it.
 */
export const SUBSCRIPTION_MODEL_IDS: readonly string[] = [
	'claude-fable-5-1',
	'claude-fable-5',
	'claude-opus-5-5',
	'claude-opus-5',
	'claude-opus-4-8',
	'claude-opus-4-7',
	'claude-opus-4-6',
	'claude-opus-4-5',
	'claude-sonnet-5',
	'claude-sonnet-4-6',
	'claude-sonnet-4-5',
	'claude-haiku-4-5',
]

const SUBSCRIPTION_MODEL_SET = new Set(SUBSCRIPTION_MODEL_IDS)

/** The dated snapshot ids the CLI's table gives for some of them: the same models. */
const SUBSCRIPTION_SNAPSHOT_IDS = new Set(['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'])

/**
 * True when the subscription can run `model`: an id in `SUBSCRIPTION_MODEL_IDS` in either
 * spelling (`anthropic/claude-haiku-4.5` too), a dated snapshot of one, or a CLI alias —
 * with or without the `[1m]` suffix.
 */
export function isSubscriptionModel(model: string): boolean {
	const id = normalizeModelId(model).toLowerCase().replace(ONE_MILLION_SUFFIX, '')
	return SUBSCRIPTION_MODEL_SET.has(id) || SUBSCRIPTION_SNAPSHOT_IDS.has(id) || CLI_MODEL_ALIASES.has(id)
}

/** Where a run on this model goes. */
export type EngineBackend = 'subscription' | 'gateway' | 'unavailable'

export function modelBackend(model: string, options: { gatewayConfigured: boolean }): EngineBackend {
	if (isClaudeModel(model)) return isSubscriptionModel(model) ? 'subscription' : 'unavailable'
	return options.gatewayConfigured ? 'gateway' : 'unavailable'
}

/** The message a refused non-Claude model carries when there is no gateway. */
export function gatewayNotConfiguredMessage(model: string): string {
	return `Model "${model}" needs an Anthropic-compatible gateway, but LLM_GATEWAY_URL / LLM_GATEWAY_TOKEN are not set.`
}

/** The message a Claude id the subscription cannot run carries. */
export function unknownClaudeModelMessage(model: string): string {
	return `Model "${model}" is not a Claude model Claude Code can run: it has been retired, or it is not an Anthropic model id. Pick a model from the list.`
}

/**
 * Why `model` cannot run, for any model `modelBackend` calls `unavailable`. Shared by the
 * stream route, the saves and the engine, so each refuses with the same words.
 */
export function unrunnableModelMessage(model: string): string {
	return isClaudeModel(model) ? unknownClaudeModelMessage(model) : gatewayNotConfiguredMessage(model)
}

/** A save's answer about a model: the id to store, or why it cannot be stored. */
export type RunnableModelChange = { ok: true; model: string | undefined } | { ok: false; message: string }

/**
 * Whether a save may set an engine model, and the id to store for it.
 *
 * For every save that feeds the engine — the default model, an agent's model from its editor
 * or from the `update_agent` tool. The pickers already offer only runnable models; this is
 * the same rule for a request that did not come through one, so an unrunnable model cannot
 * be saved and then fail on the first message.
 *
 * - `next` undefined (the field was not sent) passes through.
 * - Only a change is checked. Editors send every field on save, and a model stored before
 *   this rule — an agent left on a third-party model for its automations, say — must not
 *   stop its owner saving an unrelated edit. So `next` equal to `current`, in either
 *   spelling, is kept as sent.
 * - A change to a model that can run is stored as the engine sends it (`normalizeModelId`).
 */
export function checkRunnableModelChange(
	next: string | undefined,
	current: string | null | undefined,
	options: { gatewayConfigured: boolean },
): RunnableModelChange {
	if (next === undefined) return { ok: true, model: undefined }
	if (current != null && (next === current || normalizeModelId(next) === normalizeModelId(current))) {
		return { ok: true, model: next }
	}
	if (modelBackend(next, options) === 'unavailable') return { ok: false, message: unrunnableModelMessage(next) }
	return { ok: true, model: normalizeModelId(next) }
}
