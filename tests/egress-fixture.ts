/**
 * Shared fixtures for the egress-guard specs (`tools.egress-guard.spec.ts`,
 * `tools.web-browser.spec.ts`).
 *
 * The guard refuses loopback, which is exactly where a fixture server has to live. So the
 * specs that need to *reach* the fixture hand the guard `fixtureLookup`: it answers
 * `fixture.test` with 127.0.0.1 and sends every other name through the real policy, with a
 * stand-in DNS table where `intranet.test` "resolves" to a private address. Anything that
 * should be refused is refused by production code; `hits('/secret')` proves the fixture never
 * saw it.
 */

import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import zlib from 'node:zlib'
import { createGuardedLookup } from '../src/lib/tools/egress.server'

export type Answer = { address: string; family: number }

/** A stand-in DNS: the names these specs need, and nothing else. */
export function fakeResolver(table: Record<string, Answer[]>) {
	const asked: string[] = []
	const resolve = (
		hostname: string,
		_options: unknown,
		callback: (err: NodeJS.ErrnoException | null, addresses: Answer[]) => void,
	) => {
		asked.push(hostname)
		const answers = table[hostname]
		if (answers) process.nextTick(callback, null, answers)
		else process.nextTick(callback, Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), [])
	}
	return { resolve, asked }
}

export const DNS_TABLE: Record<string, Answer[]> = {
	'intranet.test': [{ address: '10.1.2.3', family: 4 }],
	'rebind.test': [
		{ address: '93.184.216.34', family: 4 },
		{ address: '127.0.0.1', family: 4 },
	],
	'mapped.test': [{ address: '::ffff:169.254.169.254', family: 6 }],
	'public.test': [
		{ address: '93.184.216.34', family: 4 },
		{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
	],
}

export const FIXTURE_HOST = 'fixture.test'

const guardedFakeDns = createGuardedLookup(fakeResolver(DNS_TABLE).resolve)

/** `fixture.test` → the loopback fixture; every other name goes through the real policy. */
export const fixtureLookup: LookupFunction = (hostname, options, callback) => {
	if (hostname === FIXTURE_HOST) {
		const answer = { address: '127.0.0.1', family: 4 }
		if (options?.all) process.nextTick(callback, null, [answer])
		else process.nextTick(callback, null, answer.address, answer.family)
		return
	}
	guardedFakeDns(hostname, options, callback)
}

export type Fixture = {
	port: number
	/** `http://fixture.test:<port><path>` */
	url(path: string): string
	/** How many requests `path` has served since the last `reset()`. */
	hits(path: string): number
	reset(): void
	close(): Promise<void>
}

/**
 * Send `bytes` bytes, 1 MB at a time and only as fast as the client reads, with or without a
 * Content-Length. Stops early if the client hangs up — which is what a capped client does.
 */
async function sendBytes(res: http.ServerResponse, bytes: number, declare: boolean) {
	res.writeHead(200, { 'content-type': 'application/pdf', ...(declare ? { 'content-length': String(bytes) } : {}) })
	const chunk = Buffer.alloc(1024 * 1024, 'p')
	for (let sent = 0; sent < bytes && !res.destroyed; ) {
		const n = Math.min(chunk.length, bytes - sent)
		sent += n
		if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
			await new Promise<void>((resolve) => {
				const done = () => {
					res.off('drain', done)
					res.off('close', done)
					resolve()
				}
				res.on('drain', done)
				res.on('close', done)
			})
		}
	}
	if (!res.destroyed) res.end()
}

export async function startFixture(): Promise<Fixture> {
	const counts = new Map<string, number>()
	let port = 0
	const server = http.createServer((req, res) => {
		const path = req.url ?? '/'
		counts.set(path, (counts.get(path) ?? 0) + 1)
		const redirect = (location: string) => {
			res.writeHead(302, { location })
			res.end()
		}
		// `/bytes?n=<count>[&declare=1]` — a body of exactly that size, for the size caps.
		const bytesRoute = /^\/bytes\?n=(\d+)(&declare=1)?$/.exec(path)
		if (bytesRoute) {
			void sendBytes(res, Number(bytesRoute[1]), Boolean(bytesRoute[2]))
			return
		}
		switch (path) {
			case '/ok':
				res.end('hello')
				return
			case '/secret':
				res.end('top secret')
				return
			case '/redirect-literal':
				return redirect(`http://127.0.0.1:${port}/secret`)
			case '/redirect-mapped':
				return redirect(`http://[::ffff:127.0.0.1]:${port}/secret`)
			case '/redirect-metadata':
				return redirect('http://169.254.169.254/latest/meta-data/iam/security-credentials/')
			case '/redirect-intranet':
				return redirect(`http://intranet.test:${port}/secret`)
			case '/redirect-relative':
				return redirect('/ok')
			case '/redirect-file':
				return redirect('file:///etc/passwd')
			case '/loop':
				return redirect('/loop')
			case '/big-declared':
				res.writeHead(200, { 'content-length': '5000' })
				res.end(Buffer.alloc(5000, 'a'))
				return
			case '/big-streamed':
				res.writeHead(200)
				for (let i = 0; i < 5; i++) res.write(Buffer.alloc(1000, 'b'))
				res.end()
				return
			case '/gzip':
				res.writeHead(200, { 'content-encoding': 'gzip' })
				res.end(zlib.gzipSync('compressed hello'))
				return
			case '/gzip-bomb':
				res.writeHead(200, { 'content-encoding': 'gzip' })
				res.end(zlib.gzipSync(Buffer.alloc(200_000, 0)))
				return
			case '/not-found':
				res.writeHead(404)
				res.end('nope')
				return
			case '/slow':
				// Headers and one byte, then nothing: only the deadline can end this.
				res.writeHead(200)
				res.write('x')
				return
			case '/page':
				// A public page that tries to reach private addresses from inside the browser.
				res.writeHead(200, { 'content-type': 'text/html' })
				res.end(`<!doctype html><html><head><title>Fixture page</title></head><body>
					<p id="text">public page</p>
					<img src="http://127.0.0.1:${port}/secret">
					<iframe src="http://intranet.test:${port}/secret"></iframe>
					<script>
						fetch('http://127.0.0.1:${port}/secret').catch(() => {});
						fetch('http://[::ffff:127.0.0.1]:${port}/secret').catch(() => {});
					</script>
				</body></html>`)
				return
			default:
				res.writeHead(404)
				res.end()
		}
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	port = (server.address() as AddressInfo).port
	return {
		port,
		url: (path) => `http://${FIXTURE_HOST}:${port}${path}`,
		hits: (path) => counts.get(path) ?? 0,
		reset: () => counts.clear(),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.()
				server.close(() => resolve())
			}),
	}
}
