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

const RETURN_PATH_FALLBACK = '/projects'
/** Any C0 control character or DEL. A CR/LF in a Location header is response splitting. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * The `?return=` path the OAuth round trip lands on, reduced to a path on this site.
 *
 * `/source-control/github/connect?return=https://evil.example` used to be an open redirect:
 * the value went into a cookie verbatim and the callback redirected to it. GitHub
 * auto-approves an app the user has already authorised, so one click on a crafted link sent
 * a signed-in user straight to an attacker's page, from this origin's URL. Only same-origin
 * paths survive; anything else falls back to `/projects`.
 *
 * Checked on the way in (connect) AND on the way out (callback): the cookie is
 * client-controlled, and one set by an older deploy would otherwise still be honoured.
 *
 * `//host` and `/\host` are rejected outright because browsers read both as a new host. The
 * final `new URL` resolution is the backstop: whatever the string looks like, if it does not
 * resolve to the base origin it is not a path here — and the path it resolves to is checked
 * again, because dot segments normalise `/..//evil.example` into `//evil.example`.
 */
export function sanitizeOAuthReturnPath(value: string | null | undefined): string {
	if (!value || !value.startsWith('/')) return RETURN_PATH_FALLBACK
	if (value.startsWith('//') || value.includes('\\') || CONTROL_CHARACTERS.test(value)) return RETURN_PATH_FALLBACK
	const base = 'http://return-path.invalid'
	let resolved: URL
	try {
		resolved = new URL(value, base)
	} catch {
		return RETURN_PATH_FALLBACK
	}
	if (resolved.origin !== base || resolved.pathname.startsWith('//')) return RETURN_PATH_FALLBACK
	return `${resolved.pathname}${resolved.search}${resolved.hash}`
}

/** The return path with `?error=<reason>` in place of its own query — how a failed round trip reports back. */
export function oauthFailureLocation(returnTo: string, reason: string): string {
	const target = new URL(sanitizeOAuthReturnPath(returnTo), 'http://return-path.invalid')
	target.search = ''
	target.hash = ''
	target.searchParams.set('error', reason)
	return `${target.pathname}${target.search}`
}
