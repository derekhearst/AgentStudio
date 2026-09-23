import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The one-time setup token: what stops the first visitor to a public URL from claiming a
 * fresh (or reset) instance.
 *
 * `/setup` has to be reachable without a session — that is its job — so on its own it
 * belongs to whoever loads it first. On a production server it therefore also asks for a
 * token that only the operator can see: it is printed to the server's log the first time
 * the server finds itself without an owner, and it lives only in this process's memory.
 * A restart prints a new one; completing setup retires it.
 *
 * Most deployments never meet it. With `AUTH_PASSWORD` set the owner is created at boot
 * (see provision.server.ts), so `/setup` never opens at all; the token is for an instance
 * started without one. A development server (`vite dev`) does not ask for it.
 *
 * No SvelteKit imports, so the specs can drive it; callers pass SvelteKit's build-time `dev`.
 */

/** Whether setup must present the token. The build flag, never `NODE_ENV` — see dev-bypass.ts for why. */
export function setupTokenRequired(input: { devBuild: boolean }): boolean {
	return !input.devBuild
}

let current: string | null = null

/**
 * The live token, created — and printed — on first use.
 *
 * Printed with `console`, not the app logger: the logger also writes to the `app_logs`
 * table, and a secret has no business in a table the UI can page through.
 */
export function announceSetupToken(): string {
	if (current) return current
	current = randomBytes(18).toString('base64url')
	console.warn(
		[
			'',
			'[auth] ─────────────────────────────────────────────────────────────',
			'[auth] This instance has no owner yet. To finish setup, open /setup',
			`[auth] and enter this one-time setup token:  ${current}`,
			'[auth] (Or set AUTH_PASSWORD and restart to create the owner directly.)',
			'[auth] ─────────────────────────────────────────────────────────────',
			'',
		].join('\n'),
	)
	return current
}

function digest(value: string) {
	return createHash('sha256').update(value).digest()
}

/** Whether `candidate` is the live token. Constant-time, and false when no token has been issued. */
export function setupTokenMatches(candidate: unknown): boolean {
	if (!current || typeof candidate !== 'string' || candidate.length === 0) return false
	// Compare digests, so the comparison is constant-time whatever the candidate's length.
	return timingSafeEqual(digest(candidate.trim()), digest(current))
}

/** Setup is done: the token must not open anything again. */
export function retireSetupToken() {
	current = null
}
