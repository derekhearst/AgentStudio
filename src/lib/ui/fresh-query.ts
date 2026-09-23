import type { RemoteQuery } from '@sveltejs/kit'

/**
 * Read a remote query from the server, never from the client's query cache.
 *
 * Calling a remote `query()` again with the same arguments hands back the value SvelteKit
 * cached the first time, for as long as that cache entry lives — and a page that first
 * awaited it inside `onMount` keeps the entry alive for as long as the page is open. So a
 * page that reloads its data by calling the query again, after a command or from a
 * Refresh button, gets back exactly what it already had: the database changed and the
 * screen did not. /settings found this first and fixed it for itself; a dozen other
 * pages kept the pattern.
 *
 * Use this for every imperative load, the first one included: an entry left over from an
 * earlier visit to the page is just as stale. It costs nothing extra on a first load,
 * because a query that has not started yet is fetched once, by the refresh.
 *
 * Rejects when the fetch fails, so a caller's `catch` sees a failed refresh rather than
 * the previous value.
 */
export async function fetchFresh<T>(query: RemoteQuery<T>): Promise<T> {
	await query.refresh()
	return await query
}
