/**
 * Resolve `$app/server` lazily so server modules that re-export remote functions are
 * importable from non-SvelteKit contexts (Playwright Node test runtime, scripts). In
 * SvelteKit dev/build the dynamic import resolves and the real implementations are used;
 * in Node-only contexts the import fails and we fall back to inert no-ops that preserve
 * the function shape (the test code path never calls the remote handlers — they're only
 * invoked over HTTP from a real SvelteKit request).
 *
 * Top-level await is intentional and safe: `await import(...)` settles fast on both
 * paths (resolved module in Vite, MODULE_NOT_FOUND in Node). No circular-await deadlock
 * because this module has no other imports that depend back on it.
 */

type RemoteShape = {
	command: (...args: unknown[]) => unknown
	query: (...args: unknown[]) => unknown
	getRequestEvent: () => { locals: { user?: unknown } }
	read?: (asset: string) => Response
}

const fallback: RemoteShape = {
	command: (_schema: unknown, fn: unknown) => fn as unknown,
	query: (_schema: unknown, fn: unknown) => fn as unknown,
	getRequestEvent: () => {
		throw new Error('$app/server not available outside a SvelteKit request context')
	},
}

let resolved: RemoteShape = fallback
try {
	const mod = (await import('$app/server')) as unknown as RemoteShape
	resolved = mod
} catch {
	// $app/server isn't resolvable here — keep the fallback. Real callers (HTTP requests
	// from a SvelteKit dev/prod server) never hit this branch; tests that import remote
	// modules through barrels load the inert versions and never call them.
}

export const command = resolved.command as <Schema, Output>(
	...args: unknown[]
) => Output
export const query = resolved.query as <Schema, Output>(
	...args: unknown[]
) => Output
export const getRequestEvent = resolved.getRequestEvent
export const read = resolved.read
