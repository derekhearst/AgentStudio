/**
 * Notice a client that goes away while a route is still working on its request.
 *
 * `event.request.signal` does not do this once the body has been read. Under adapter-node
 * and the Vite dev server, SvelteKit's `getRequest` aborts that signal only when the
 * connection closes before the request body has been read in full — so a route that has
 * awaited `request.json()` never hears that the client left, and goes on to start work
 * (a paid upstream call, say) that nobody will receive.
 *
 * The Node request's socket does close, so this listens there. adapter-node passes that
 * request as `platform.req` (Node and Bun both close the socket when the client aborts);
 * the dev server passes no platform, and there the request signal is all there is.
 *
 * Call `dispose()` once the work is done: with keep-alive the socket outlives the request.
 */

import type { Socket } from 'node:net'

export type ClientDisconnect = {
	/** Aborts when the client disconnects, or when the request's own signal does. */
	signal: AbortSignal
	/** Stop listening to the socket. */
	dispose: () => void
}

/**
 * What adapter-node puts on `event.platform`. Typed here because the adapter's ambient
 * `App.Platform` is not part of this project's types, and the dev server passes none.
 */
type NodePlatform = { req?: { socket?: Socket | null } } | null | undefined

export function clientDisconnectSignal(event: { request: Request; platform?: unknown }): ClientDisconnect {
	const socket = (event.platform as NodePlatform)?.req?.socket
	if (!socket) return { signal: event.request.signal, dispose: () => {} }

	const controller = new AbortController()
	const onClose = () => controller.abort(new DOMException('The client disconnected.', 'AbortError'))
	if (socket.destroyed) onClose()
	else socket.once('close', onClose)
	return {
		signal: AbortSignal.any([controller.signal, event.request.signal]),
		dispose: () => {
			socket.off('close', onClose)
		},
	}
}
