import {
	AZURE_DEFAULT_SCOPES,
	AZURE_OAUTH_RETURN_COOKIE,
	AZURE_OAUTH_STATE_COOKIE,
	buildAzureAuthorizeUrl,
	buildAzureCallbackUriFromOrigin,
	generateAzureOAuthState,
} from './azure-devops-oauth'

/**
 * Source control redesign — server-side Azure DevOps OAuth helpers.
 *
 * Mirrors the GitHub OAuth pattern (env credentials + token-exchange via fetch). Pure URL
 * helpers live in `./azure-devops-oauth` so they can be unit-tested without $env.
 *
 * Required scopes (read + clone the user's repos):
 *   - `vso.code_write` — read + clone + push
 *   - `vso.profile` — basic profile so we can populate `provider_account`
 */

export {
	AZURE_OAUTH_STATE_COOKIE,
	AZURE_OAUTH_RETURN_COOKIE,
	AZURE_DEFAULT_SCOPES,
	buildAzureAuthorizeUrl,
	generateAzureOAuthState,
}

export function getAzureDevOpsOAuthCredentials(): { clientId: string; clientSecret: string } | null {
	const clientId = process.env.AZURE_DEVOPS_OAUTH_CLIENT_ID
	const clientSecret = process.env.AZURE_DEVOPS_OAUTH_CLIENT_SECRET
	if (!clientId || !clientSecret) return null
	return { clientId, clientSecret }
}

export function isAzureDevOpsOAuthConfigured(): boolean {
	return getAzureDevOpsOAuthCredentials() !== null
}

export function buildAzureRedirectUri(origin: string): string {
	const override = process.env.AZURE_DEVOPS_OAUTH_CALLBACK_URL
	if (override && override.length > 0) return override
	return buildAzureCallbackUriFromOrigin(origin)
}

export type AzureExchangeResult = {
	accessToken: string
	refreshToken: string | null
	tokenType: string
	scopes: string[]
	expiresInSeconds: number | null
	error?: undefined
}

export type AzureExchangeError = {
	accessToken?: undefined
	error: string
	errorDescription?: string
}

/**
 * Exchange the authorization assertion for an access token. Azure DevOps's token endpoint
 * is non-standard: it expects a `client_assertion` field that IS the client secret, not a
 * signed JWT. Documented at the link in `azure-devops-oauth.ts`.
 */
export async function exchangeAzureCodeForToken(input: {
	clientSecret: string
	assertion: string
	redirectUri: string
	grantType?: 'urn:ietf:params:oauth:grant-type:jwt-bearer' | 'refresh_token'
}): Promise<AzureExchangeResult | AzureExchangeError> {
	const body = new URLSearchParams({
		client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		client_assertion: input.clientSecret,
		grant_type: input.grantType ?? 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		assertion: input.assertion,
		redirect_uri: input.redirectUri,
	})
	const res = await fetch('https://app.vssps.visualstudio.com/oauth2/token', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		return { error: 'azure_http_error', errorDescription: `HTTP ${res.status} ${text.slice(0, 200)}` }
	}
	const json = (await res.json()) as Record<string, unknown>
	if (typeof json.error === 'string') {
		return {
			error: json.error,
			errorDescription:
				typeof json.error_description === 'string' ? json.error_description : undefined,
		}
	}
	const accessToken = json.access_token
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		return { error: 'no_access_token' }
	}
	const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null
	const tokenType = typeof json.token_type === 'string' ? json.token_type : 'Bearer'
	const expiresInSeconds = typeof json.expires_in === 'number' ? json.expires_in : null
	const scopes =
		typeof json.scope === 'string' ? json.scope.split(/[\s,]+/).filter((s) => s.length > 0) : []
	return { accessToken, refreshToken, tokenType, scopes, expiresInSeconds }
}

export async function fetchAzureUser(
	accessToken: string,
): Promise<{ id: string; displayName: string; emailAddress: string | null }> {
	const res = await fetch('https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			'User-Agent': 'AgentStudio',
		},
	})
	if (!res.ok) {
		throw new Error(`Failed to fetch Azure DevOps profile: HTTP ${res.status}`)
	}
	const json = (await res.json()) as {
		id?: string
		displayName?: string
		emailAddress?: string
		publicAlias?: string
	}
	if (!json.id || !json.displayName) {
		throw new Error('Unexpected Azure DevOps profile payload')
	}
	return {
		id: json.id,
		displayName: json.displayName,
		emailAddress: json.emailAddress ?? null,
	}
}
