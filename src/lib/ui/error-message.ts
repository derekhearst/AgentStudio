import { isHttpError } from '@sveltejs/kit'

/**
 * What to show when a remote call fails.
 *
 * A remote function rejects with SvelteKit's `HttpError`, which is not an `Error`, so the
 * usual `err instanceof Error ? err.message : fallback` always fell through to the fallback.
 * A 4xx carries a message written for the user (see `$lib/server/user-input-error`) and is
 * shown as is. A 5xx carries only "Internal Error", so the caller's own wording is kinder.
 * An `Error` raised in the page itself — a field that is not valid JSON — is shown as is.
 */
export function describeError(err: unknown, fallback: string): string {
	if (isHttpError(err)) return err.status < 500 && err.body?.message ? err.body.message : fallback
	if (err instanceof Error && err.message) return err.message
	return fallback
}
