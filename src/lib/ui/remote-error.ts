import { isHttpError } from '@sveltejs/kit'

/**
 * The message to show for a failed remote-function call.
 *
 * A remote call rejects with SvelteKit's `HttpError`, which is not an `Error` — so the usual
 * `err instanceof Error ? err.message : fallback` shows the fallback for every refusal a
 * server function deliberately explains (`error(403, '…')`). A 4xx carries a message written
 * for the user (see `$lib/server/user-input-error`) and is shown as is. A 5xx carries only
 * "Internal Error", so the caller's own wording is kinder. A plain `Error` — a network
 * failure, a client-side throw such as a field that is not valid JSON — is shown as is.
 */
export function remoteErrorMessage(err: unknown, fallback: string): string {
	if (isHttpError(err)) return err.status < 500 && err.body?.message ? err.body.message : fallback
	if (err instanceof Error && err.message) return err.message
	return fallback
}
