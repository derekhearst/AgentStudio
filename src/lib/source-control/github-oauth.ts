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

const RETURN_SENTINEL_ORIGIN = 'https://agentstudio.invalid'

/**
 * Where to send the user after the OAuth round-trip: a path on this app, or `fallback`.
 *
 * `?return=` arrives on a GET that anything can link to, and the callback redirects to
 * it, so an unchecked value is an open redirect: `return=https://attacker.example/<data>`
 * turns the app into a bounce to any site. Only a same-origin path is accepted. It must
 * start with exactly one `/` (`//host` and `/\host` are other hosts to a browser), may
 * not contain a backslash or any control character or space (the URL parser drops tabs
 * and newlines, which can reassemble `//`), and must still be on our origin once parsed.
 * What is returned is the parsed path and query, so the redirect goes where the check
 * looked. A fragment is dropped: the callback appends `?error=` to the path.
 */
export function safeReturnPath(raw: string | null | undefined, fallback = '/projects'): string {
	if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return fallback
	if (raw.includes('\\') || /[\x00-\x20\x7f]/.test(raw)) return fallback
	let url: URL
	try {
		url = new URL(raw, `${RETURN_SENTINEL_ORIGIN}/`)
	} catch {
		return fallback
	}
	// `/.//host` and `/..//host` pass the checks above and parse to the path `//host`.
	if (url.origin !== RETURN_SENTINEL_ORIGIN || url.pathname.startsWith('//')) return fallback
	return `${url.pathname}${url.search}`
}
