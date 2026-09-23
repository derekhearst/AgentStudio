import type { RequestEvent } from '@sveltejs/kit'
import { dev } from '$app/environment'
import { ownerExists } from '$lib/auth/auth.server'
import { resolveAuthGate } from '$lib/auth/gate'
import { announceSetupToken, setupTokenRequired } from '$lib/auth/setup-token.server'

/**
 * The page gate, wired to the database: where `hooks.server.ts` should redirect a page or
 * endpoint request, or null to serve it. The rules themselves are the pure
 * `resolveAuthGate` in gate.ts.
 *
 * While the instance has no owner, a production server also makes sure the setup token has
 * been printed, so the operator finds it in the log by the time they reach `/setup` — the
 * first request of any kind (a health probe included) prints it.
 */
export async function authGateRedirect(event: Pick<RequestEvent, 'url' | 'locals'>): Promise<string | null> {
	const hasOwner = await ownerExists()
	if (!hasOwner && setupTokenRequired({ devBuild: dev })) announceSetupToken()
	return resolveAuthGate({
		pathname: event.url.pathname,
		ownerExists: hasOwner,
		authenticated: event.locals.authenticated === true,
	})
}
