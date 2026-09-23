import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { clientDisconnectSignal, type ClientDisconnect } from '../src/lib/server/client-disconnect'

/**
 * #27 review — the server has to be able to tell that a read-aloud listener pressed Stop.
 *
 * `/api/tts` reads its JSON body before it synthesises, and after that SvelteKit's
 * `request.signal` never fires under adapter-node, so the route could not tell that the
 * listener had gone before it paid for a synthesis. `clientDisconnectSignal` listens on the
 * Node socket instead.
 *
 * These run a real `node:http` server, the way adapter-node hands the request over as
 * `platform.req`, and read the whole body first, the way the route does.
 */

type Handled = { body: string; disconnect: ClientDisconnect; closeListenersBefore: number; closeListenersAfter?: number }

/** A server that reads each body, takes the signal, and answers after `holdMs`. */
async function startServer(holdMs: number) {
	const handled: Handled[] = []
	const server = http.createServer((req, res) => {
		let body = ''
		req.on('data', (chunk) => (body += chunk))
		req.on('end', () => {
			const closeListenersBefore = req.socket.listenerCount('close')
			const request = new Request('http://127.0.0.1/api/tts', { method: 'POST' })
			const entry: Handled = { body, disconnect: clientDisconnectSignal({ request, platform: { req } }), closeListenersBefore }
			handled.push(entry)
			setTimeout(() => {
				entry.disconnect.dispose()
				entry.closeListenersAfter = req.socket.listenerCount('close')
				if (!res.destroyed) res.end('done')
			}, holdMs)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return { origin, handled, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('a client that aborts after sending its body aborts the signal', async () => {
	const server = await startServer(1_500)
	try {
		const client = new AbortController()
		const call = fetch(`${server.origin}/`, { method: 'POST', body: '{"text":"hello"}', signal: client.signal }).catch(
			(err: unknown) => err,
		)
		await expect.poll(() => server.handled.length).toBe(1)
		const [entry] = server.handled
		// The body has been read in full, and the request's own signal would stay quiet from here.
		expect(entry.body).toBe('{"text":"hello"}')
		expect(entry.disconnect.signal.aborted).toBe(false)

		client.abort()
		await call
		await expect.poll(() => entry.disconnect.signal.aborted, { timeout: 5_000 }).toBe(true)
		expect((entry.disconnect.signal.reason as Error).name).toBe('AbortError')
	} finally {
		await server.close()
	}
})

test('a request answered normally is not aborted, and its socket listener is removed', async () => {
	const server = await startServer(100)
	try {
		// Two requests on one keep-alive connection: the socket outlives the first request.
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
		const post = (body: string) =>
			new Promise<string>((resolve, reject) => {
				const req = http.request(`${server.origin}/`, { method: 'POST', agent }, (res) => {
					let text = ''
					res.on('data', (chunk) => (text += chunk))
					res.on('end', () => resolve(text))
				})
				req.on('error', reject)
				req.end(body)
			})
		try {
			expect(await post('first')).toBe('done')
			expect(await post('second')).toBe('done')
		} finally {
			agent.destroy()
		}
		expect(server.handled.map((h) => h.body)).toEqual(['first', 'second'])
		for (const entry of server.handled) {
			expect(entry.disconnect.signal.aborted, entry.body).toBe(false)
			expect(entry.closeListenersAfter, entry.body).toBe(entry.closeListenersBefore)
		}
	} finally {
		await server.close()
	}
})

test('without a Node request — the dev server — the request signal is used as it is', () => {
	const aborted = new AbortController()
	const request = new Request('http://127.0.0.1/api/tts', { method: 'POST', signal: aborted.signal })
	const disconnect = clientDisconnectSignal({ request })
	aborted.abort()
	expect(disconnect.signal.aborted).toBe(true)
	disconnect.dispose()

	// A socket that is already gone aborts at once.
	const gone = clientDisconnectSignal({
		request: new Request('http://127.0.0.1/api/tts'),
		platform: { req: { socket: { destroyed: true, once: () => undefined, off: () => undefined } } },
	})
	expect(gone.signal.aborted).toBe(true)
})
