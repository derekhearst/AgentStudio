import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
	GITHUB_OAUTH_RETURN_COOKIE,
	GITHUB_OAUTH_STATE_COOKIE,
	buildAuthorizeUrl,
	buildRedirectUri,
	generateOAuthState,
	getGithubOAuthCredentials,
} from '$lib/source-control/github-oauth.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Wave 5 #19 phase 2 — start the GitHub OAuth flow.
 *
 * Generates a one-shot CSRF state, stores it in an HTTP-only cookie, and 302s the user
 * to GitHub. The callback handler verifies the state matches before exchanging the code.
 * Optional `?return=/path` param survives the round-trip via a second cookie.
 */

export const GET: RequestHandler = async ({ url, cookies }) => {
	requireAuthenticatedRequestUser()

	const credentials = getGithubOAuthCredentials()
	if (!credentials) {
		// Surface a friendly error instead of redirecting into a broken GitHub flow.
		return new Response(
			JSON.stringify({
				error: 'github_oauth_not_configured',
				message:
					'Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET in the environment to enable GitHub login.',
			}),
			{ status: 503, headers: { 'Content-Type': 'application/json' } },
		)
	}

	const state = generateOAuthState()
	const returnTo = url.searchParams.get('return') ?? '/projects'
	const redirectUri = buildRedirectUri(url.origin)

	cookies.set(GITHUB_OAUTH_STATE_COOKIE, state, {
		path: '/source-control/github',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600,
	})
	cookies.set(GITHUB_OAUTH_RETURN_COOKIE, returnTo, {
		path: '/source-control/github',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600,
	})

	const authorizeUrl = buildAuthorizeUrl({
		clientId: credentials.clientId,
		redirectUri,
		state,
	})
	throw redirect(302, authorizeUrl)
}
