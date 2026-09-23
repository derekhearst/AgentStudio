/**
 * Model ids in the form OpenRouter accepts.
 *
 * The app keeps two spellings of the same Claude model. The Agent SDK engine wants the bare
 * Anthropic id (`claude-haiku-4-5`) — `normalizeModelId` in `$lib/engine/options.server`
 * strips a vendor prefix for it — and since the engine migration that is what the defaults
 * and stored settings hold. OpenRouter wants its own catalogue slug (`anthropic/claude-haiku-4.5`)
 * and rejects anything else with a 400. Every call that still goes straight to OpenRouter
 * (`chat()` and `streamChat()` in `./chat.server`: the memory extractor and reranker, titles,
 * research, evaluators, monitors, automations, the legacy runtime loop) therefore converts here
 * first, or it fails on every call. The usage ledger's price lookup (`$lib/costs/model-pricing`)
 * converts the same way, because the catalogue it prices from is OpenRouter's: looked up by the
 * stored bare id, every such call was priced at nothing.
 *
 * Pure and dependency-free, so a spec can pin the mapping without a network.
 */

const ANTHROPIC_PREFIX = 'anthropic/'
/** Anthropic's CLI-style suffixes that name a variant, not a model: `claude-sonnet-4-5[1m]`. */
const VARIANT_SUFFIX = /\[[^\]]*\]$/
/** A snapshot date: `claude-opus-4-1-20250805`. OpenRouter's slugs name the model, not the snapshot. */
const SNAPSHOT_SUFFIX = /-\d{8}$/
/**
 * A dashed version pair (`4-5`, `3-7`) that OpenRouter writes with a dot (`4.5`, `3.7`). It may
 * be followed by more of the name or by an OpenRouter variant (`:batch`). No lookbehind: this
 * module is small enough to end up in a browser bundle.
 */
const DASHED_VERSION = /-(\d+)-(\d{1,2})(?=[-:]|$)/

/** `claude-sonnet-4-5-20250929[1m]` → `claude-sonnet-4.5`. */
function toCatalogueSlug(slug: string): string {
	const bare = slug.toLowerCase().replace(VARIANT_SUFFIX, '').replace(SNAPSHOT_SUFFIX, '')
	return bare.replace(DASHED_VERSION, '-$1.$2')
}

/**
 * The OpenRouter slug for `model`.
 *
 * - A bare Claude id gains the `anthropic/` prefix, loses a snapshot date or `[1m]` variant,
 *   and has its version written with a dot: `claude-haiku-4-5` → `anthropic/claude-haiku-4.5`,
 *   `claude-3-5-sonnet-20241022` → `anthropic/claude-3.5-sonnet`, `claude-sonnet-5` →
 *   `anthropic/claude-sonnet-5`.
 * - An `anthropic/…` id written the SDK's way (`anthropic/claude-sonnet-4-6`) gets the dot;
 *   one already in catalogue form (`anthropic/claude-haiku-4.5`, `…:batch`) is unchanged.
 * - Another vendor's id (`openai/gpt-4o-mini`) is already OpenRouter's own spelling.
 * - Anything else — a bare alias like `sonnet` that names no specific model — is returned
 *   unchanged, so OpenRouter's own error names it rather than this function guessing.
 */
export function toOpenRouterModelId(model: string): string {
	const trimmed = model.trim()
	const lower = trimmed.toLowerCase()
	if (lower.startsWith(ANTHROPIC_PREFIX)) {
		return `${ANTHROPIC_PREFIX}${toCatalogueSlug(trimmed.slice(ANTHROPIC_PREFIX.length))}`
	}
	if (trimmed.includes('/')) return trimmed
	if (!lower.startsWith('claude-')) return trimmed
	return `${ANTHROPIC_PREFIX}${toCatalogueSlug(trimmed)}`
}
