/**
 * The page half of the session gate — which request goes where, as a pure function.
 *
 * `hooks.server.ts` asks `resolveAuthGate` about every request that is not a remote-function
 * call (those are settled earlier, on their real path — see remote-gate.ts) and redirects
 * when it answers with a path. Nothing here touches the database or SvelteKit, so the whole
 * matrix can be tested without a server, and in particular without a database that has no
 * owner: the suite's database always has one, and deleting it would cascade through every
 * other spec's data.
 *
 * Two states:
 *
 *   No owner yet  — first run. Only the setup page, the static bundle, the favicon and the
 *                   health check are reachable; everything else, `/login` included, goes to
 *                   `/setup`. The health check is open so a deploy probe can see a fresh
 *                   instance come up (it used to get a 303 to `/setup` instead of JSON).
 *   Owner exists  — `/setup` is closed for good, and a visitor without a session reaches
 *                   only the public paths below.
 */

/**
 * Paths a visitor without a session may load once the instance has an owner.
 *
 * `/api/webhooks` is unauthenticated by design — third-party providers (GitHub, …) POST
 * here without session cookies. The handlers verify provider signatures themselves so the
 * path-level skip is safe; never broaden this prefix without an explicit signature check.
 * `/api/cron` is public for the same reason: an external scheduler has no session, so the
 * handler checks a session OR the CRON_SECRET bearer itself, and refuses when neither holds.
 */
export const PUBLIC_PATH_PREFIXES = ['/login', '/setup', '/demo', '/api/webhooks', '/api/health', '/api/cron'] as const

/** Paths reachable before an owner exists (plus the static bundle and the favicon). */
export const FIRST_RUN_PATH_PREFIXES = ['/setup', '/api/health'] as const

/**
 * Public pages that render bare, without the console shell.
 *
 * The shell's nav fetches the credit balance, which is an authenticated query, so
 * rendering it for a visitor without a session threw 401 before the page's own content
 * mattered — `/demo` returned 401 for exactly this reason, and on a fresh install `/setup`
 * did too (#1), which left an empty database with no way in. The root layout reads this
 * list, and the gate spec checks that every page reachable before an owner exists is on it.
 */
export const CHROMELESS_PATH_PREFIXES = ['/login', '/setup', '/demo'] as const

function matchesPrefix(pathname: string, prefix: string) {
	return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** The static bundle and the favicon, which every page needs whatever state the instance is in. */
function isStaticAsset(pathname: string) {
	// `/_app` here is the static bundle. Remote functions (`/_app/remote/…`) never get this
	// far: `handle` settles them first, because their pathname is not the real one.
	return pathname.startsWith('/_app') || pathname.startsWith('/favicon')
}

export function isPublicPath(pathname: string) {
	return isStaticAsset(pathname) || PUBLIC_PATH_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))
}

export function rendersWithoutShell(pathname: string) {
	return CHROMELESS_PATH_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))
}

/**
 * Where to send a request, or null to let it through.
 *
 * `authenticated` is whether the request carries a live session (or the dev bypass attached
 * one). It is ignored before an owner exists: there is nobody to be signed in as.
 */
export function resolveAuthGate(input: { pathname: string; ownerExists: boolean; authenticated: boolean }): string | null {
	const { pathname, ownerExists, authenticated } = input

	if (!ownerExists) {
		if (isStaticAsset(pathname) || FIRST_RUN_PATH_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
			return null
		}
		return '/setup'
	}

	// Once there is an owner, /setup is no longer reachable.
	if (matchesPrefix(pathname, '/setup')) return authenticated ? '/' : '/login'

	if (!authenticated && !isPublicPath(pathname)) return '/login'

	if (authenticated && pathname === '/login') return '/'

	return null
}
