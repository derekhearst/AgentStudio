import { randomBytes } from 'node:crypto'

/**
 * Wave 5 #19 phase 2 — pure GitHub OAuth helpers.
 *
 * URL construction + state generation. The .server.ts wrapper reads env credentials and
 * does the network exchange. These pure helpers can be imported from tests without pulling
 * in $env.
 */

export const GITHUB_OAUTH_STATE_COOKIE = 'AgentStudio_github_oauth_state'
export const GITHUB_OAUTH_RETURN_COOKIE = 'AgentStudio_github_oauth_return'
export const GITHUB_DEFAULT_SCOPES = ['repo', 'read:user', 'read:org'] as const

/**
 * Where a user connects or reconnects GitHub: the Connections panel on /projects. The old
 * standalone /source-control page is gone (only its OAuth endpoints remain), so every "no
 * connection" message is built here and none can drift back to a route that 404s.
 */
export const GITHUB_CONNECT_PAGE = '/projects'

export function githubNotConnectedMessage(beforeWhat: string): string {
	return `No active GitHub connection. Connect GitHub from the Connections panel at ${GITHUB_CONNECT_PAGE} before ${beforeWhat}.`
}

export const GITHUB_RECONNECT_MESSAGE = `GitHub connection unavailable. Reconnect from the Connections panel at ${GITHUB_CONNECT_PAGE}.`

export function generateOAuthState(): string {
	return randomBytes(24).toString('base64url')
}

export function buildAuthorizeUrl(input: {
	clientId: string
	redirectUri: string
	state: string
	scopes?: readonly string[]
}): string {
	const params = new URLSearchParams({
		client_id: input.clientId,
		redirect_uri: input.redirectUri,
		state: input.state,
		scope: (input.scopes ?? GITHUB_DEFAULT_SCOPES).join(' '),
		allow_signup: 'false',
	})
	return `https://github.com/login/oauth/authorize?${params.toString()}`
}

export function buildCallbackUriFromOrigin(origin: string): string {
	return `${origin.replace(/\/$/, '')}/source-control/github/callback`
}
