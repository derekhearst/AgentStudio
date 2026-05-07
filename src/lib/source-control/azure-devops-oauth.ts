import { randomBytes } from 'node:crypto'

/**
 * Source control redesign — pure Azure DevOps OAuth helpers.
 *
 * URL construction + state generation. The .server.ts wrapper reads env credentials and
 * does the network exchange. These pure helpers can be imported from tests without pulling
 * in $env.
 *
 * Azure DevOps uses the legacy `app.vssps.visualstudio.com` OAuth endpoints. Apps must be
 * registered at https://app.vsaex.visualstudio.com/app/register. The token endpoint expects
 * a JWT-style assertion (the client secret IS the assertion); not OAuth-spec-clean but
 * documented at https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/oauth.
 */

export const AZURE_OAUTH_STATE_COOKIE = 'AgentStudio_azure_oauth_state'
export const AZURE_OAUTH_RETURN_COOKIE = 'AgentStudio_azure_oauth_return'
// vso.code = read repos; vso.code_write = clone (and push when used by agent tools);
// vso.profile = identity. The token grants ALL of these to every connected org.
export const AZURE_DEFAULT_SCOPES = ['vso.code_write', 'vso.profile'] as const

export function generateAzureOAuthState(): string {
	return randomBytes(24).toString('base64url')
}

export function buildAzureAuthorizeUrl(input: {
	clientId: string
	redirectUri: string
	state: string
	scopes?: readonly string[]
}): string {
	const params = new URLSearchParams({
		client_id: input.clientId,
		response_type: 'Assertion',
		state: input.state,
		scope: (input.scopes ?? AZURE_DEFAULT_SCOPES).join(' '),
		redirect_uri: input.redirectUri,
	})
	return `https://app.vssps.visualstudio.com/oauth2/authorize?${params.toString()}`
}

export function buildAzureCallbackUriFromOrigin(origin: string): string {
	return `${origin.replace(/\/$/, '')}/source-control/azure-devops/callback`
}
