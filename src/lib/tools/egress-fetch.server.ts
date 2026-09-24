/**
 * A `fetch` that goes through the egress guard, for clients that take a fetch implementation
 * and would otherwise reach the network on their own. The connectors' connection test (#17)
 * hands it to the MCP client, whose transports make every request through it.
 *
 * Same rules as the rest of the guard (`./egress.server`, `./egress-policy`):
 *
 *   - the URL's spelling is checked first (`validateEgressUrl`), and every address its host
 *     resolves to is checked at connect time (`guardedLookup`), on the very socket that is used;
 *   - redirects are never followed. A server that answers with one gets an error naming where it
 *     pointed, so the operator can enter the final URL — which is then checked like any other.
 *     `guardedGet` follows redirects by re-checking each hop; nothing here needs that, and a
 *     POST replayed at a second host is not something to do on a server's say-so;
 *   - the response body is capped.
 *
 * The one exception is a host the operator named in `allowedPrivateHosts` (for connectors,
 * `MCP_ALLOWED_PRIVATE_HOSTS`): that exact host may resolve to a private address. Nothing else
 * inherits the exemption — not another host, and not a redirect, since none is followed.
 *
 * The body is streamed rather than buffered, because an MCP server answers over Server-Sent
 * Events, and an SSE stream stays open for as long as the client listens.
 */

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { EgressBlockedError, EgressTooLargeError, guardedLookup } from './egress.server'
import { normalizeHost, validateEgressUrl } from './egress-policy'

/** The shape the MCP SDK's transports accept as their `fetch` option. */
export type GuardedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type GuardedFetchOptions = {
	/**
	 * Test seam, as in `GuardedGetOptions`: production leaves it unset so every connection
	 * resolves through `guardedLookup`; a spec passes one that can reach a fixture on loopback.
	 */
	lookup?: LookupFunction
	/** Host names (normalised, as `normalizeHost` spells them) the operator allows to be private. */
	allowedPrivateHosts?: ReadonlySet<string>
	/** Cap on one response body. Default 8 MiB. */
	maxResponseBytes?: number
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NULL_BODY_STATUSES = new Set([204, 205, 304])
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const USER_AGENT = 'AgentStudio-connectors/1.0 (+https://github.com/derekhearst/AgentStudio)'

function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason
	if (reason instanceof Error) return reason
	return new DOMException('This operation was aborted', 'AbortError')
}

async function requestBody(body: RequestInit['body']): Promise<Buffer | null> {
	if (body === undefined || body === null) return null
	if (typeof body === 'string') return Buffer.from(body, 'utf8')
	if (body instanceof Uint8Array) return Buffer.from(body)
	if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body))
	if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
	if (body instanceof Blob) return Buffer.from(new Uint8Array(await body.arrayBuffer()))
	throw new TypeError('This fetch sends only text or byte bodies.')
}

/** Build the guarded fetch. See the module note for what it refuses. */
export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
	const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

	return async (input, init = {}) => {
		let url: URL
		try {
			url = new URL(String(input))
		} catch {
			throw new TypeError(`Invalid URL: ${String(input).slice(0, 200)}`)
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new EgressBlockedError(`unsupported protocol "${url.protocol}" (only http/https allowed)`)
		}
		const privateAllowed = options.allowedPrivateHosts?.has(normalizeHost(url.hostname)) ?? false
		if (!privateAllowed) {
			const check = validateEgressUrl(url)
			if (!check.ok) throw new EgressBlockedError(check.error)
		}
		const lookup: LookupFunction =
			options.lookup ?? (privateAllowed ? (dns.lookup as unknown as LookupFunction) : guardedLookup)

		const signal = init.signal ?? undefined
		if (signal?.aborted) throw abortError(signal)

		const headers: Record<string, string> = {}
		new Headers(init.headers).forEach((value, name) => {
			headers[name] = value
		})
		// Asked for plainly, so the body needs no decoding before the client reads it.
		headers['accept-encoding'] = 'identity'
		headers['user-agent'] ??= USER_AGENT
		const payload = await requestBody(init.body)
		if (payload) headers['content-length'] = String(payload.length)
		const method = (init.method ?? 'GET').toUpperCase()

		return await new Promise<Response>((resolve, reject) => {
			let settled = false
			const fail = (err: Error) => {
				if (settled) return
				settled = true
				reject(err)
			}
			const client = url.protocol === 'https:' ? https : http
			const req = client.request(
				url,
				// A pooled socket was opened by someone else's lookup; never reuse one.
				{ method, headers, lookup, agent: false },
				(res) => {
					const status = res.statusCode ?? 0
					if (REDIRECT_STATUSES.has(status)) {
						res.resume()
						const target = String(res.headers.location ?? 'another address').slice(0, 200)
						fail(new Error(`The server redirected to ${target}. Redirects are not followed; use the final URL.`))
						return
					}
					if (status < 200 || status > 599) {
						res.destroy()
						fail(new Error(`The server answered with HTTP status ${status}.`))
						return
					}
					const declared = Number(res.headers['content-length'])
					if (Number.isFinite(declared) && declared > maxBytes) {
						res.destroy()
						fail(new EgressTooLargeError(`The response from ${url.host} is ${declared} bytes, over the ${maxBytes}-byte cap.`))
						return
					}

					const responseHeaders = new Headers()
					for (const [name, value] of Object.entries(res.headers)) {
						if (value === undefined) continue
						if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
						else responseHeaders.set(name, value)
					}

					let body: ReadableStream<Uint8Array> | null = null
					if (NULL_BODY_STATUSES.has(status) || method === 'HEAD') {
						res.resume()
					} else {
						let seen = 0
						let done = false
						body = new ReadableStream<Uint8Array>({
							start(controller) {
								const finish = (err?: Error) => {
									if (done) return
									done = true
									try {
										if (err) controller.error(err)
										else controller.close()
									} catch {
										// Already closed by a cancel.
									}
								}
								res.on('data', (chunk: Buffer) => {
									if (done) return
									seen += chunk.length
									if (seen > maxBytes) {
										const err = new EgressTooLargeError(`The response from ${url.host} is larger than ${maxBytes} bytes.`)
										finish(err)
										res.destroy(err)
										return
									}
									controller.enqueue(new Uint8Array(chunk))
								})
								res.on('end', () => finish())
								res.on('error', (err) => finish(err))
								res.on('close', () => finish(res.complete ? undefined : new Error('The connection closed early.')))
							},
							cancel() {
								done = true
								res.destroy()
							},
						})
					}
					settled = true
					resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }))
				},
			)
			// Aborting tears down the request, and with it a response still being streamed.
			signal?.addEventListener(
				'abort',
				() => {
					const err = abortError(signal)
					req.destroy(err)
					fail(err)
				},
				{ once: true },
			)
			req.on('error', (err) => fail(err))
			if (payload) req.write(payload)
			req.end()
		})
	}
}
