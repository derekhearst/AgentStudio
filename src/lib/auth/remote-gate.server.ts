import type { RequestEvent } from '@sveltejs/kit'
import { loginCommand, setupCommand } from '$lib/auth/auth.remote'
import { decideRemoteCall, remoteCallRefusal } from '$lib/auth/remote-gate'
import { logger } from '$lib/observability/logger'

/**
 * The remote functions a visitor without a session may call — the two that create one.
 *
 * `/login` calls `loginCommand` and `/setup` calls `setupCommand`, and nothing else on
 * either page calls a remote function (the chromeless layout keeps the console shell, and
 * its authenticated queries, off both). Both commands guard themselves: login verifies the
 * password, setup refuses once an owner exists (and, on a production server, without the
 * setup token from the server log). `getSession` and `logout` live in the same file but are
 * deliberately NOT here — nothing anonymous calls them, and "allow what the public pages
 * need" means exactly this list.
 *
 * Adding to it makes a function callable by anyone on the internet. Do that only for a
 * function that is safe with `locals.user` null, and say why here.
 */
const ANONYMOUS_REMOTE_FUNCTIONS = { loginCommand, setupCommand }

let anonymousIds: ReadonlySet<string> | null = null

/**
 * The ids SvelteKit dispatches these functions under, read from the function objects.
 *
 * SvelteKit stamps `fn.__.id = '<hash>/<name>'` on every remote function when it transforms
 * the module — the same id its dispatcher looks up — so reading it back keeps this list
 * correct by construction instead of re-deriving the hash from a file path. `__` is not in
 * SvelteKit's public types; if a release ever stops setting it, the set comes back short,
 * which refuses the anonymous calls (login breaks loudly) rather than allowing them.
 */
function anonymousRemoteIds(): ReadonlySet<string> {
	if (anonymousIds) return anonymousIds
	const ids = new Set<string>()
	for (const [name, fn] of Object.entries(ANONYMOUS_REMOTE_FUNCTIONS)) {
		const id = (fn as unknown as { __?: { id?: unknown } }).__?.id
		if (typeof id === 'string' && id.includes('/')) {
			ids.add(id)
		} else {
			logger.error(`[auth] cannot read the remote id of ${name}; anonymous calls to it will be refused`)
		}
	}
	anonymousIds = ids
	return ids
}

/**
 * A 401 for an anonymous remote call that is not on the list, otherwise null.
 *
 * Call this in `handle` after `locals.authenticated` is set and before anything reads
 * `event.url.pathname` — for a remote call that value came from the client.
 */
export function refuseAnonymousRemoteCall(
	event: Pick<RequestEvent, 'request' | 'isRemoteRequest' | 'locals'>,
): Response | null {
	const decision = decideRemoteCall({
		requestUrl: event.request.url,
		isRemoteRequest: event.isRemoteRequest,
		authenticated: event.locals.authenticated === true,
		anonymousIds: anonymousRemoteIds(),
	})
	return decision === 'refuse' ? remoteCallRefusal() : null
}
