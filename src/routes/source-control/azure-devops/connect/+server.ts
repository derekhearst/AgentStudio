import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
	AZURE_OAUTH_RETURN_COOKIE,
	AZURE_OAUTH_STATE_COOKIE,
	buildAzureAuthorizeUrl,
	buildAzureRedirectUri,
	generateAzureOAuthState,
	getAzureDevOpsOAuthCredentials,
} from '$lib/source-control/azure-devops-oauth.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Source control redesign — start the Azure DevOps OAuth flow.
 *
 * Mirrors the GitHub equivalent: generates a one-shot CSRF state, stores it in an
 * HTTP-only cookie, and 302s to Azure DevOps. The callback verifies the state before
 * exchanging the code.
 */

export const GET: RequestHandler = async ({ url, cookies }) => {
	requireAuthenticatedRequestUser()

	const credentials = getAzureDevOpsOAuthCredentials()
	if (!credentials) {
		return new Response(
			JSON.stringify({
				error: 'azure_devops_oauth_not_configured',
				message:
					'Set AZURE_DEVOPS_OAUTH_CLIENT_ID and AZURE_DEVOPS_OAUTH_CLIENT_SECRET in the environment to enable Azure DevOps OAuth.',
			}),
			{ status: 503, headers: { 'Content-Type': 'application/json' } },
		)
	}

	const state = generateAzureOAuthState()
	const returnTo = url.searchParams.get('return') ?? '/projects'
	const redirectUri = buildAzureRedirectUri(url.origin)

	cookies.set(AZURE_OAUTH_STATE_COOKIE, state, {
		path: '/source-control/azure-devops',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600,
	})
	cookies.set(AZURE_OAUTH_RETURN_COOKIE, returnTo, {
		path: '/source-control/azure-devops',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600,
	})

	const authorizeUrl = buildAzureAuthorizeUrl({
		clientId: credentials.clientId,
		redirectUri,
		state,
	})
	throw redirect(302, authorizeUrl)
}
