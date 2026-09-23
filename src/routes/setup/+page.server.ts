import { dev } from '$app/environment'
import { setupTokenRequired } from '$lib/auth/setup-token.server'
import type { PageServerLoad } from './$types'

/**
 * Only whether to ask for the setup token. The hook has already decided this page may be
 * shown (there is no owner yet), and printed the token to the server log if one is needed.
 *
 * Nothing here needs a session and nothing may throw for the lack of one: this page is the
 * way into an empty instance (#1).
 */
export const load: PageServerLoad = async () => {
	return { setupTokenRequired: setupTokenRequired({ devBuild: dev }) }
}
