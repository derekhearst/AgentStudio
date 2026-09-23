/**
 * The remote-function half of the session gate — the pure part.
 *
 * SvelteKit serves every `query` / `command` / `form` exported from a `*.remote.ts` file at
 * `/_app/remote/<hash>/<name>`, where `<hash>` is derived from the file's path. Before
 * `handle` runs it REWRITES `event.url.pathname` for those requests to the value of the
 * `x-sveltekit-pathname` request header: the page the call was made from, as the client
 * reports it. The page gate in hooks.server.ts decides on `event.url.pathname`, so an
 * anonymous call that sent `x-sveltekit-pathname: /login` passed as a request for a public
 * page, and every remote function without its own session check ran with `locals.user`
 * null — skills could be created and overwritten, agent prompts, run transcripts and spend
 * were readable. Nothing about that needs a browser: the ids are in the public
 * `/_app/immutable` bundles, and the Origin check SvelteKit does on remote POSTs compares a
 * header any other client can set.
 *
 * So remote calls are decided on what actually identifies them — the function id in the
 * REAL request URL (`event.request.url`, which SvelteKit leaves alone) — and never on
 * `event.url`. Without a session, a call is allowed only when its id is on an explicit
 * list; everything else is refused with a 401 before any remote code is loaded.
 *
 * No SvelteKit or `$app` imports here, so specs can import it directly. The list itself is
 * built in `remote-gate.server.ts`, from the function objects.
 */

/** Where SvelteKit serves remote functions. svelte.config.js sets neither `paths.base` nor `appDir`. */
export const REMOTE_PATH_PREFIX = '/_app/remote/'

/**
 * `<hash>/<name>` of the remote function a request calls, or null when it calls none.
 *
 * Parsed exactly the way SvelteKit's dispatcher parses it — the raw path split on `/`, no
 * decoding — so the id checked here is the id that would be run. Anything after the name
 * (`query.batch` and `prerender` put arguments there) does not change which function runs,
 * so it is dropped.
 *
 * A remote `form` has a second entry point: submitted without JavaScript it is a POST to
 * whatever page it is on, with the id in a `/remote` search parameter. No `form()` is
 * exported today; covering it costs one line and stops a future one being callable
 * anonymously through `/login?/remote=…`.
 */
export function remoteFunctionId(requestUrl: string | URL): string | null {
	const url = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl
	const raw = url.pathname.startsWith(REMOTE_PATH_PREFIX)
		? url.pathname.slice(REMOTE_PATH_PREFIX.length)
		: url.searchParams.get('/remote')
	if (!raw) return null
	const [hash, name] = raw.split('/')
	return `${hash}/${name ?? ''}`
}

export type RemoteGateDecision = 'not-remote' | 'allow' | 'refuse'

/**
 * Whether a request may reach remote code.
 *
 * `isRemoteRequest` is SvelteKit's own classification and wins over the parse: if the path
 * layout ever changes so that `remoteFunctionId` cannot read an id, the call is still
 * treated as remote, and an anonymous one is refused rather than waved through.
 */
export function decideRemoteCall(input: {
	requestUrl: string | URL
	isRemoteRequest: boolean
	authenticated: boolean
	anonymousIds: ReadonlySet<string>
}): RemoteGateDecision {
	const id = remoteFunctionId(input.requestUrl)
	if (!id && !input.isRemoteRequest) return 'not-remote'
	if (input.authenticated) return 'allow'
	return id && input.anonymousIds.has(id) ? 'allow' : 'refuse'
}

/**
 * The refusal, in the shape SvelteKit's client expects from a failed remote call, so
 * `await someQuery()` rejects with a 401 `HttpError` carrying this message instead of a
 * JSON parse failure.
 *
 * A 401 rather than a redirect to /login: SvelteKit would serialise a redirect thrown from
 * `handle` as `{ type: 'redirect' }`, which the remote-function client does not act on, and
 * a status says "refused" to anyone reading a log or a curl transcript.
 */
export function remoteCallRefusal(): Response {
	return new Response(JSON.stringify({ type: 'error', status: 401, error: { message: 'Not authenticated' } }), {
		status: 401,
		headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
	})
}
