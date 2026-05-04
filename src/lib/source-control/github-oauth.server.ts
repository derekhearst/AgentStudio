import { env } from '$env/dynamic/private'
import {
	GITHUB_DEFAULT_SCOPES,
	GITHUB_OAUTH_RETURN_COOKIE,
	GITHUB_OAUTH_STATE_COOKIE,
	buildAuthorizeUrl,
	buildCallbackUriFromOrigin,
	generateOAuthState,
} from './github-oauth'

/**
 * Wave 5 #19 phase 2 — server-side GitHub OAuth helpers.
 *
 * Reads credentials from env + does the actual code↔token exchange via fetch. Pure
 * helpers (URL construction, state generation) live in `./github-oauth` so unit tests can
 * import them without pulling in $env.
 *
 * Required scopes (read + write to the user's repos + ability to open PRs):
 *   - `repo` — full repo access (read + write, private + public)
 *   - `read:user` — basic profile so we can populate `provider_account`
 *   - `read:org` — see org-owned repos the user has access to
 */

export {
	GITHUB_OAUTH_STATE_COOKIE,
	GITHUB_OAUTH_RETURN_COOKIE,
	GITHUB_DEFAULT_SCOPES,
	buildAuthorizeUrl,
	generateOAuthState,
}

export function getGithubOAuthCredentials(): { clientId: string; clientSecret: string } | null {
	const clientId = env.GITHUB_OAUTH_CLIENT_ID
	const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET
	if (!clientId || !clientSecret) return null
	return { clientId, clientSecret }
}

export function isGithubOAuthConfigured(): boolean {
	return getGithubOAuthCredentials() !== null
}

export function buildRedirectUri(origin: string): string {
	// Honors GITHUB_OAUTH_CALLBACK_URL when set so deployments behind a reverse proxy can
	// pin the absolute callback (avoids origin-mismatch with the GitHub OAuth App config).
	const override = env.GITHUB_OAUTH_CALLBACK_URL
	if (override && override.length > 0) return override
	return buildCallbackUriFromOrigin(origin)
}

export type ExchangeCodeResult = {
	accessToken: string
	tokenType: string
	scopes: string[]
	error?: undefined
}

export type ExchangeCodeError = {
	accessToken?: undefined
	error: string
	errorDescription?: string
}

export async function exchangeCodeForToken(input: {
	clientId: string
	clientSecret: string
	code: string
	redirectUri: string
	state: string
}): Promise<ExchangeCodeResult | ExchangeCodeError> {
	const body = new URLSearchParams({
		client_id: input.clientId,
		client_secret: input.clientSecret,
		code: input.code,
		redirect_uri: input.redirectUri,
		state: input.state,
	})
	const res = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	})
	if (!res.ok) {
		return { error: 'github_http_error', errorDescription: `HTTP ${res.status}` }
	}
	const json = (await res.json()) as Record<string, unknown>
	if (typeof json.error === 'string') {
		return {
			error: json.error,
			errorDescription: typeof json.error_description === 'string' ? json.error_description : undefined,
		}
	}
	const accessToken = json.access_token
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		return { error: 'no_access_token' }
	}
	const tokenType = typeof json.token_type === 'string' ? json.token_type : 'bearer'
	const scopes =
		typeof json.scope === 'string' ? json.scope.split(/[\s,]+/).filter((s) => s.length > 0) : []
	return { accessToken, tokenType, scopes }
}

export async function fetchGithubUser(accessToken: string): Promise<{ login: string; id: number; name?: string }> {
	const res = await fetch('https://api.github.com/user', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'AgentStudio',
		},
	})
	if (!res.ok) {
		throw new Error(`Failed to fetch GitHub user: HTTP ${res.status}`)
	}
	const json = (await res.json()) as { login?: string; id?: number; name?: string }
	if (!json.login || typeof json.id !== 'number') {
		throw new Error('Unexpected GitHub user payload')
	}
	return { login: json.login, id: json.id, name: json.name }
}
