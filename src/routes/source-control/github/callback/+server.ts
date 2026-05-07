import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
	GITHUB_OAUTH_RETURN_COOKIE,
	GITHUB_OAUTH_STATE_COOKIE,
	buildRedirectUri,
	exchangeCodeForToken,
	fetchGithubUser,
	getGithubOAuthCredentials,
} from '$lib/source-control/github-oauth.server'
import { encryptSecret } from '$lib/source-control/encryption.server'
import { upsertConnection } from '$lib/source-control/source-control.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { logger } from '$lib/observability/logger'

/**
 * Wave 5 #19 phase 2 — GitHub OAuth callback.
 *
 * Steps:
 *   1. Verify the state cookie matches the `state` query param (CSRF defense).
 *   2. Exchange the `code` for an access token via GitHub's token endpoint.
 *   3. Fetch the authenticated user (login + id) so we can populate `provider_account`.
 *   4. Encrypt the token + upsert into `repository_connections`.
 *   5. Clear the OAuth cookies + 302 back to the requested return URL.
 *
 * On any failure, redirects to /source-control with an `?error=` query param so the page
 * can surface a friendly message. Never bubbles a token through a query param or fragment.
 */

export const GET: RequestHandler = async ({ url, cookies }) => {
	const user = requireAuthenticatedRequestUser()
	const returnTo = cookies.get(GITHUB_OAUTH_RETURN_COOKIE) ?? '/source-control'

	function fail(reason: string): never {
		cookies.delete(GITHUB_OAUTH_STATE_COOKIE, { path: '/source-control/github' })
		cookies.delete(GITHUB_OAUTH_RETURN_COOKIE, { path: '/source-control/github' })
		throw redirect(302, `${returnTo.split('?')[0]}?error=${encodeURIComponent(reason)}`)
	}

	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const errorParam = url.searchParams.get('error')
	if (errorParam) fail(errorParam)
	if (!code || !state) fail('missing_code_or_state')

	const expectedState = cookies.get(GITHUB_OAUTH_STATE_COOKIE)
	if (!expectedState || expectedState !== state) fail('state_mismatch')

	const credentials = getGithubOAuthCredentials()
	if (!credentials) fail('github_oauth_not_configured')

	const exchange = await exchangeCodeForToken({
		clientId: credentials.clientId,
		clientSecret: credentials.clientSecret,
		code,
		redirectUri: buildRedirectUri(url.origin),
		state,
	})
	if (exchange.error || !exchange.accessToken) {
		fail(exchange.error ?? 'token_exchange_failed')
	}

	const accessToken = exchange.accessToken
	const scopes = exchange.scopes ?? []

	let ghUser: Awaited<ReturnType<typeof fetchGithubUser>>
	try {
		ghUser = await fetchGithubUser(accessToken)
	} catch (err) {
		logger.warn('[source-control/github/callback] fetchGithubUser failed', { err })
		fail('user_lookup_failed')
	}

	const encrypted = encryptSecret(accessToken)
	await upsertConnection({
		userId: user.id,
		provider: 'github',
		providerAccount: ghUser.login,
		encryptedToken: encrypted,
		scopes,
	})

	cookies.delete(GITHUB_OAUTH_STATE_COOKIE, { path: '/source-control/github' })
	cookies.delete(GITHUB_OAUTH_RETURN_COOKIE, { path: '/source-control/github' })

	throw redirect(302, returnTo)
}
