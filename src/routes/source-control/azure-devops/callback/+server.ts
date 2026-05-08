import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
	AZURE_OAUTH_RETURN_COOKIE,
	AZURE_OAUTH_STATE_COOKIE,
	buildAzureRedirectUri,
	exchangeAzureCodeForToken,
	fetchAzureUser,
	getAzureDevOpsOAuthCredentials,
} from '$lib/source-control/azure-devops-oauth.server'
import { listAzureAccounts } from '$lib/source-control/azure-devops-api.server'
import { encryptSecret } from '$lib/source-control/encryption.server'
import { upsertConnection } from '$lib/source-control/source-control.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { logger } from '$lib/observability/logger'

/**
 * Source control redesign — Azure DevOps OAuth callback.
 *
 * Steps:
 *   1. Verify state matches the cookie.
 *   2. Exchange the assertion for an access token (Azure's non-standard JWT-bearer flow).
 *   3. Fetch the user profile + the list of accounts (orgs) the user belongs to.
 *   4. Encrypt the token + upsert one `repository_connections` row per org so per-org
 *      clone auth is keyed by `providerAccount = org name`.
 *   5. Redirect back to the page.
 */

export const GET: RequestHandler = async ({ url, cookies }) => {
	const user = requireAuthenticatedRequestUser()
	const returnTo = cookies.get(AZURE_OAUTH_RETURN_COOKIE) ?? '/projects'

	function fail(reason: string): never {
		cookies.delete(AZURE_OAUTH_STATE_COOKIE, { path: '/source-control/azure-devops' })
		cookies.delete(AZURE_OAUTH_RETURN_COOKIE, { path: '/source-control/azure-devops' })
		throw redirect(302, `${returnTo.split('?')[0]}?error=${encodeURIComponent(reason)}`)
	}

	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const errorParam = url.searchParams.get('error')
	if (errorParam) fail(errorParam)
	if (!code || !state) fail('missing_code_or_state')

	const expectedState = cookies.get(AZURE_OAUTH_STATE_COOKIE)
	if (!expectedState || expectedState !== state) fail('state_mismatch')

	const credentials = getAzureDevOpsOAuthCredentials()
	if (!credentials) fail('azure_devops_oauth_not_configured')

	const redirectUri = buildAzureRedirectUri(url.origin)
	const exchange = await exchangeAzureCodeForToken({
		clientSecret: credentials.clientSecret,
		assertion: code,
		redirectUri,
	})
	if (exchange.error || !exchange.accessToken) {
		fail(exchange.error ?? 'token_exchange_failed')
	}

	const accessToken = exchange.accessToken
	const scopes = exchange.scopes ?? []

	let profile: Awaited<ReturnType<typeof fetchAzureUser>>
	try {
		profile = await fetchAzureUser(accessToken)
	} catch (err) {
		logger.warn('[source-control/azure-devops/callback] fetchAzureUser failed', { err })
		fail('user_lookup_failed')
	}

	let accounts: Awaited<ReturnType<typeof listAzureAccounts>>
	try {
		accounts = await listAzureAccounts(accessToken)
	} catch (err) {
		logger.warn('[source-control/azure-devops/callback] listAzureAccounts failed', { err })
		fail('account_lookup_failed')
	}

	const encrypted = encryptSecret(accessToken)

	if (accounts.length === 0) {
		// Fall back to the profile display name as a single connection so the user can at
		// least paste private clone URLs by org name and have the credential helper work.
		await upsertConnection({
			userId: user.id,
			provider: 'azure_devops',
			providerAccount: profile.displayName,
			encryptedToken: encrypted,
			scopes,
		})
	} else {
		for (const account of accounts) {
			if (!account.accountName) continue
			await upsertConnection({
				userId: user.id,
				provider: 'azure_devops',
				providerAccount: account.accountName,
				encryptedToken: encrypted,
				scopes,
			})
		}
	}

	cookies.delete(AZURE_OAUTH_STATE_COOKIE, { path: '/source-control/azure-devops' })
	cookies.delete(AZURE_OAUTH_RETURN_COOKIE, { path: '/source-control/azure-devops' })

	throw redirect(302, returnTo)
}
