/**
 * Wave 4 #18 phase 4 — pure resolver for per-agent research config.
 *
 * The orchestrator loop has hardcoded defaults (planner model, sub-question cap, URL fetch
 * count). Per-agent config in `agents.config.research` overrides these so admins can tune
 * specific agents — e.g. a "deep researcher" agent uses claude-sonnet-4 + 8 sub-questions
 * + 3 URLs per question for higher-quality output, while a "quick researcher" agent stays
 * on gpt-4o-mini + 3 sub-questions for cheap exploratory passes.
 *
 * Pure module (no $env / db / SvelteKit deps) so unit tests pin the override semantics
 * without spinning up the runtime.
 */

export type ResolvedResearchConfig = {
	enabled: boolean
	plannerModel: string
	synthesizerModel: string
	maxSubQuestions: number
	urlsPerQuestion: number
	maxFetchChars: number
}

export const DEFAULT_RESEARCH_CONFIG: ResolvedResearchConfig = {
	enabled: true,
	// These two model fields are *fallbacks* — when a research run carries a composer-selected
	// model on `research.model`, the orchestrator overrides both with that value. Per-agent
	// `agents.config.research` still wins over these defaults but loses to the composer pick.
	plannerModel: 'anthropic/claude-sonnet-4-6',
	synthesizerModel: 'anthropic/claude-sonnet-4-6',
	// Defaults bumped (Deep Research rebuild): 5→8, 2→4, 30k→50k. With these a default run
	// visits ~32 sources (8 sub-questions × 4 URLs each) instead of the prior ~10. The reflect
	// phase can add up to 4 follow-up queries × urlsPerQuestion more, so total source count for
	// a default run lands in the 30-50 range — comparable to Claude Deep Research output.
	maxSubQuestions: 8,
	urlsPerQuestion: 4,
	maxFetchChars: 50_000,
}

const MAX_SUB_QUESTIONS_HARDCAP = 12
const MAX_URLS_PER_QUESTION_HARDCAP = 8

/**
 * Read an agent's `config.research` field and merge with defaults. Returns a fully-resolved
 * config object — every field has a value. Out-of-range values are clamped to safe limits
 * so a bad config can't blow up the runner.
 *
 * Pass `null` (or a config without a `research` key) to get the defaults.
 */
export function resolveResearchConfig(agentConfig: Record<string, unknown> | null | undefined): ResolvedResearchConfig {
	if (!agentConfig || typeof agentConfig !== 'object') return { ...DEFAULT_RESEARCH_CONFIG }
	const raw = (agentConfig as { research?: unknown }).research
	if (!raw || typeof raw !== 'object') return { ...DEFAULT_RESEARCH_CONFIG }
	const overrides = raw as Record<string, unknown>

	return {
		enabled: typeof overrides.enabled === 'boolean' ? overrides.enabled : DEFAULT_RESEARCH_CONFIG.enabled,
		plannerModel:
			typeof overrides.plannerModel === 'string' && overrides.plannerModel.trim().length > 0
				? overrides.plannerModel.trim()
				: DEFAULT_RESEARCH_CONFIG.plannerModel,
		synthesizerModel:
			typeof overrides.synthesizerModel === 'string' && overrides.synthesizerModel.trim().length > 0
				? overrides.synthesizerModel.trim()
				: DEFAULT_RESEARCH_CONFIG.synthesizerModel,
		maxSubQuestions: clampInt(
			overrides.maxSubQuestions,
			1,
			MAX_SUB_QUESTIONS_HARDCAP,
			DEFAULT_RESEARCH_CONFIG.maxSubQuestions,
		),
		urlsPerQuestion: clampInt(
			overrides.urlsPerQuestion,
			1,
			MAX_URLS_PER_QUESTION_HARDCAP,
			DEFAULT_RESEARCH_CONFIG.urlsPerQuestion,
		),
		maxFetchChars: clampInt(overrides.maxFetchChars, 5_000, 100_000, DEFAULT_RESEARCH_CONFIG.maxFetchChars),
	}
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	const intValue = Math.floor(value)
	if (intValue < min) return min
	if (intValue > max) return max
	return intValue
}
