/**
 * Centralized server-side env-var access.
 *
 * Replaces direct `process.env.*` reads scattered across domain modules. Each
 * value is read once at module load (or behind a getter for build-time-safe
 * vars), validated, and documented in one place.
 *
 * This module does NOT cover infrastructure vars that are intentionally read
 * inline (NODE_ENV, PATH, SYSTEMROOT, BUILD_PHASE, etc.) — those are tied to
 * runtime probes and can stay where they are.
 *
 * Use the helpers below in domain code:
 *   - `requireOpenRouterApiKey()` — throws a uniform error if unset.
 *   - `getSandboxRoot()` — returns the sandbox root with documented default.
 *   - `getCronSecret()` — returns the trimmed secret, or `undefined`.
 *
 * For one-off vars, prefer adding a typed accessor here over reading inline.
 */

const DEFAULT_SANDBOX_ROOT = '/workspace'

function readEnv(key: string): string | undefined {
	const raw = process.env[key]
	if (raw === undefined) return undefined
	const trimmed = raw.trim()
	return trimmed === '' ? undefined : trimmed
}

/**
 * Returns the OpenRouter API key, or throws the same error every caller used to
 * throw inline. Use this anywhere you need to authenticate with OpenRouter.
 */
export function requireOpenRouterApiKey(): string {
	const key = readEnv('OPENROUTER_API_KEY')
	if (!key) {
		throw new Error('OPENROUTER_API_KEY is not configured')
	}
	return key
}

/** Non-throwing variant — returns undefined when unset. */
export function getOpenRouterApiKey(): string | undefined {
	return readEnv('OPENROUTER_API_KEY')
}

/**
 * Returns the user-workspace sandbox root. Defaults to `/workspace` when unset.
 * Per-user subdirectories are layered on top by the workspace handler.
 */
export function getSandboxRoot(): string {
	return readEnv('SANDBOX_WORKSPACE') ?? DEFAULT_SANDBOX_ROOT
}

/** Returns the SearXNG base URL or `undefined` if web search isn't configured. */
export function getSearxngUrl(): string | undefined {
	return readEnv('SEARXNG_URL')
}

/** Returns the SearXNG basic-auth password if set; web search is unauthenticated when undefined. */
export function getSearxngPassword(): string | undefined {
	return readEnv('SEARXNG_PASSWORD')
}

/** Defaults to `derek` for legacy compatibility — override via env if deploying elsewhere. */
export function getSearxngUsername(): string {
	return readEnv('SEARXNG_USERNAME') ?? 'derek'
}

/** Returns the cron-trigger shared secret, or `undefined` when cron auth is disabled. */
export function getCronSecret(): string | undefined {
	return readEnv('CRON_SECRET')
}

/** Returns the MCP API key for the `/api/mcp` endpoint, or `undefined`. */
export function getMcpApiKey(): string | undefined {
	return readEnv('MCP_API_KEY')
}

/** Returns the GitHub-webhook signing secret, or `undefined` (endpoint then 503s). */
export function getGithubWebhookSecret(): string | undefined {
	return readEnv('GITHUB_WEBHOOK_SECRET')
}

/** Returns the upload destination directory; defaults to `./uploads`. */
export function getUploadDir(): string {
	return readEnv('UPLOAD_DIR') ?? './uploads'
}

/** Returns the per-cost search-call USD price (used for SEARCH_COST_PER_CALL_USD), or 0 when unset/invalid. */
export function getSearchCostPerCall(): number {
	const raw = readEnv('SEARCH_COST_PER_CALL_USD')
	if (!raw) return 0
	const parsed = Number.parseFloat(raw)
	return Number.isFinite(parsed) ? parsed : 0
}
