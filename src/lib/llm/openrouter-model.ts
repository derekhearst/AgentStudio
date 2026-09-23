/**
 * Model ids in the form OpenRouter accepts.
 *
 * The app keeps two spellings of the same Claude model. The Agent SDK engine wants the bare
 * Anthropic id (`claude-haiku-4-5`) — `normalizeModelId` in `$lib/engine/options.server`
 * strips a vendor prefix for it — and since the engine migration that is what the defaults
 * and stored settings hold. OpenRouter wants its own catalogue slug (`anthropic/claude-haiku-4.5`)
 * and rejects anything else with a 400. Every call that still goes straight to OpenRouter
 * (`chat()` in `./chat.server`: the memory extractor and reranker, titles, research,
 * evaluators, automations) therefore converts here first, or it fails on every call.
 *
 * Pure, so it can be unit tested without a network.
 */

/** Anthropic's CLI-style suffixes that name a variant, not a model: `claude-sonnet-4-5[1m]`. */
const VARIANT_SUFFIX = /\[[^\]]*\]$/
/** A snapshot date: `claude-opus-4-1-20250805`. OpenRouter's slugs name the model, not the snapshot. */
const SNAPSHOT_SUFFIX = /-\d{8}$/
/** A dashed version pair (`4-5`, `3-7`) that OpenRouter writes with a dot (`4.5`, `3.7`). */
const DASHED_VERSION = /-(\d+)-(\d{1,2})(?=-|$)/

/**
 * The OpenRouter slug for `model`.
 *
 * - An id that already names a vendor (`anthropic/…`, `openai/gpt-4o-mini`) is returned as is.
 * - A bare Claude id gains the `anthropic/` prefix, loses a snapshot date or `[1m]` variant,
 *   and has its version written with a dot: `claude-haiku-4-5` → `anthropic/claude-haiku-4.5`,
 *   `claude-3-5-sonnet-20241022` → `anthropic/claude-3.5-sonnet`, `claude-sonnet-5` →
 *   `anthropic/claude-sonnet-5`.
 * - Anything else is returned unchanged, so OpenRouter's own error names it.
 */
export function toOpenRouterModelId(model: string): string {
	const trimmed = model.trim()
	if (trimmed.includes('/')) return trimmed
	if (!/^claude-/i.test(trimmed)) return trimmed
	const bare = trimmed.toLowerCase().replace(VARIANT_SUFFIX, '').replace(SNAPSHOT_SUFFIX, '')
	return `anthropic/${bare.replace(DASHED_VERSION, '-$1.$2')}`
}
