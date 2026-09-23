/**
 * The model id OpenRouter knows, for an id this app stores.
 *
 * Since the engine moved to the Agent SDK, Anthropic models are stored the way the SDK
 * spells them: `claude-sonnet-5`, `claude-haiku-4-5`. That is right for the engine and wrong
 * for everything that still calls OpenRouter directly — research, memory mining, reranking,
 * monitors, the legacy runtime loop — because OpenRouter's catalogue only has
 * vendor-prefixed ids with a dotted version: `anthropic/claude-sonnet-5`,
 * `anthropic/claude-haiku-4.5`. Sent as-is, the bare id is a 400, and the same mismatch
 * made the usage ledger price every such call at nothing.
 *
 * So every OpenRouter call site goes through this one function, and the price lookup uses
 * it too. It changes only what it can map with certainty:
 *
 * - a bare `claude-…` id gains the `anthropic/` prefix, loses an SDK date or context-window
 *   suffix (`-20250929`, `[1m]`), and has its version written with a dot (`4-5` → `4.5`);
 * - an `anthropic/…` id written the SDK's way (`anthropic/claude-sonnet-4-6`) gets the dot;
 * - anything else — another vendor's id, or a bare alias like `sonnet` that names no
 *   specific model — is returned untouched, so OpenRouter answers for it rather than this
 *   function guessing.
 *
 * Pure and dependency-free so a spec can pin the mapping without a network.
 */

const ANTHROPIC_PREFIX = 'anthropic/'

/** A trailing SDK snapshot date, e.g. `-20250929`. */
const DATE_SUFFIX = /-\d{8}$/
/** A trailing SDK context-window marker, e.g. `[1m]`. */
const CONTEXT_SUFFIX = /\[[^\]]*\]$/
/** Two version numbers joined by a hyphen, e.g. the `4-5` in `claude-haiku-4-5`. */
const HYPHENATED_VERSION = /(?<=-)(\d+)-(\d+)(?=[-:]|$)/

function toCatalogueSlug(slug: string): string {
	const trimmed = slug.replace(CONTEXT_SUFFIX, '').replace(DATE_SUFFIX, '')
	return trimmed.replace(HYPHENATED_VERSION, '$1.$2')
}

export function toOpenRouterModelId(model: string): string {
	const id = model.trim()
	if (id.length === 0) return id

	const lower = id.toLowerCase()
	if (lower.startsWith(ANTHROPIC_PREFIX)) {
		return `${ANTHROPIC_PREFIX}${toCatalogueSlug(id.slice(ANTHROPIC_PREFIX.length))}`
	}
	// Another vendor's id is already OpenRouter's own spelling.
	if (id.includes('/')) return id
	if (lower.startsWith('claude-')) return `${ANTHROPIC_PREFIX}${toCatalogueSlug(id)}`
	return id
}
