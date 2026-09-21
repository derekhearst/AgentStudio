import type { LayoutServerLoad } from './$types'

/**
 * Publishes the session's identity to every page as `page.data.user`.
 *
 * Added because nothing on the client could tell whether a request was authenticated.
 * `hooks.server.ts` sets `locals.user` and `locals.authenticated`, but neither reached
 * Svelte, so components that wanted to know guessed — and one that guessed wrong took a
 * whole route down: the console nav called the authenticated `getCredits()` query
 * unconditionally, so any public route rendering the shell threw 401 during SSR before
 * its own content mattered. `/demo` returned 401 for exactly that reason.
 *
 * Only non-sensitive identity fields are exposed. No password hash, no session token.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user ? { id: locals.user.id, name: locals.user.name, username: locals.user.username } : null,
		authenticated: locals.authenticated === true,
	}
}
