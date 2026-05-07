import { allToolNames, toolDescriptions, toolDisclosure } from './tool-schemas'

type ToolName = string

/**
 * Wave 5 #19 phase 3 finish — tools that ALWAYS require human approval, regardless of the
 * user's per-tool approval-mode setting. These are tools whose blast radius reaches outside
 * AgentStudio (pushing commits to a third-party SCM, opening pull requests on GitHub, etc.).
 *
 * The chat-stream handler unions this set into the runtime's `approvalRequiredTools`, so an
 * operator can never accidentally turn approval off for these. Tool execution branches also
 * refuse when the run has no approval surface (e.g. detached automation runs), so the same
 * tool registered into an automation handler will fail-closed instead of silently pushing.
 */
export const MANDATORY_APPROVAL_TOOLS: readonly ToolName[] = [
	'push_branch',
	'create_pull_request',
	// Research plan approval — the user reviews the proposed sub-questions in the sidebar
	// before the orchestrator burns LLM/web budget on a 10-15 minute background run. Always
	// requires approval; in detached/automation runs the tool fails closed.
	'propose_research_plan',
]

// Tool tier organization (always-loaded vs searchable) lives in `tool-schemas.ts:toolDisclosure`.
// The legacy `capabilityGroups` registry was removed when the `enable_capability` meta-tool
// was replaced by `search_tools` (Tool Search Tool / deferred loading).

/**
 * Model context window sizes (in tokens) for compaction calculations.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'anthropic/claude-sonnet-4': 200_000,
	'anthropic/claude-opus-4': 200_000,
	'openai/gpt-4o-mini': 128_000,
}

export function getContextWindowSize(model: string): number {
	return MODEL_CONTEXT_WINDOWS[model] ?? 200_000
}

/**
 * Token estimation. Uses js-tiktoken for known model families; falls back to chars/4 for unknown
 * models (and when the WASM-free encoder hasn't been initialized yet — first call is sync).
 *
 * Model family heuristic (based on the leading provider/model slug):
 *   - openai/* and o-series        → cl100k_base / o200k_base
 *   - anthropic/* (claude)         → cl100k_base (close-enough proxy until tiktoken ships claude)
 *   - google/* (gemini)            → cl100k_base proxy
 *   - everything else              → chars / 4 fallback
 *
 * Each encoder is lazily constructed and cached at module scope.
 */
import { encodingForModel, getEncoding, type Tiktoken, type TiktokenEncoding, type TiktokenModel } from 'js-tiktoken'

const FALLBACK_FACTOR = 4

const ENCODER_CACHE = new Map<TiktokenEncoding, Tiktoken>()
const MODEL_CACHE = new Map<TiktokenModel, Tiktoken>()
const FALLBACK_LOGGED = new Set<string>()

function getEncoder(name: TiktokenEncoding): Tiktoken | null {
	const cached = ENCODER_CACHE.get(name)
	if (cached) return cached
	try {
		const enc = getEncoding(name)
		ENCODER_CACHE.set(name, enc)
		return enc
	} catch {
		return null
	}
}

function getModelEncoder(name: TiktokenModel): Tiktoken | null {
	const cached = MODEL_CACHE.get(name)
	if (cached) return cached
	try {
		const enc = encodingForModel(name)
		MODEL_CACHE.set(name, enc)
		return enc
	} catch {
		return null
	}
}

/**
 * Pick an appropriate tiktoken encoder for a model slug. Returns null when no good match exists,
 * which causes `estimateTokensForModel` to fall back to chars/4.
 */
function encoderForModel(model: string): Tiktoken | null {
	const lower = model.toLowerCase()
	if (lower.startsWith('openai/') || lower.startsWith('o1') || lower.startsWith('gpt-')) {
		const slug = lower.replace(/^openai\//, '') as TiktokenModel
		const direct = getModelEncoder(slug)
		if (direct) return direct
		// gpt-4o family uses o200k_base
		if (slug.includes('4o') || slug.startsWith('o1') || slug.startsWith('o3')) return getEncoder('o200k_base')
		return getEncoder('cl100k_base')
	}
	// Anthropic, Google, Mistral, etc. don't have tiktoken encoders shipped — cl100k_base is a
	// reasonable proxy that's typically within ~10% of the real tokenizer for English text.
	return getEncoder('cl100k_base')
}

/**
 * Rough token estimate: chars / 4 fallback. Kept as a synchronous, model-agnostic helper for
 * places that don't know which model the text is destined for.
 */
export function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / FALLBACK_FACTOR)
}

/**
 * Model-aware token estimator. Uses tiktoken for known models, falls back to chars/4 otherwise.
 * Logs the fallback once per model so we know what's missing without spamming.
 */
export function estimateTokensForModel(text: string, model: string): number {
	if (!text) return 0
	const enc = encoderForModel(model)
	if (!enc) {
		if (!FALLBACK_LOGGED.has(model)) {
			FALLBACK_LOGGED.add(model)
			if (typeof console !== 'undefined') {
				console.warn(`[tokens] no tiktoken encoder for model "${model}"; using chars/4 fallback`)
			}
		}
		return estimateTokens(text)
	}
	try {
		return enc.encode(text).length
	} catch {
		return estimateTokens(text)
	}
}

/**
 * Estimate the token count of a tool definition (JSON schema).
 */
export function estimateToolDefinitionTokens(
	tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): number {
	return estimateTokens(JSON.stringify(tools))
}

/**
 * Tier label for a tool — drives the settings UI's "approve all/none in tier" affordance and
 * mirrors the disclosure-tier system in `tool-schemas.ts`.
 *
 *   `always`: tools loaded into the model surface on every request (small core).
 *   `searchable`: tools the model has to discover via `search_tools(query)`.
 */
export type BuiltinToolTier = 'always' | 'searchable'

export type BuiltinTool = {
	name: string
	description: string
	tier: BuiltinToolTier
	tierLabel: string
}

const tierLabels: Record<BuiltinToolTier, string> = {
	always: 'Always loaded',
	searchable: 'Searchable (via search_tools)',
}

/**
 * BUILTIN_TOOLS is derived from the canonical tool registry. Single source of truth: tool
 * names + descriptions live in `tool-schemas.ts`, the disclosure tier likewise. The settings
 * UI groups by tier so an operator can bulk-approve all "searchable" tools, etc.
 */
export const BUILTIN_TOOLS: BuiltinTool[] = allToolNames
	.map((name) => ({
		name,
		description: toolDescriptions[name] ?? '',
		tier: toolDisclosure[name] ?? 'searchable',
		tierLabel: tierLabels[toolDisclosure[name] ?? 'searchable'],
	}))
	.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier === 'always' ? -1 : 1
		return a.name.localeCompare(b.name)
	})
