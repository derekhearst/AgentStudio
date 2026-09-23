/**
 * The network half of the egress guard. `egress-policy.ts` decides which addresses are the
 * public internet; this module makes sure that decision is applied to the address that is
 * actually connected to, on every hop.
 *
 * Three ways out, one policy:
 *
 *   - `guardedLookup` — a drop-in for `dns.lookup` that refuses to hand back a blocked
 *     address, and refuses the whole name if ANY of its addresses is blocked. Every socket
 *     this module opens resolves through it, so the address that was checked is the address
 *     that gets connected to. There is no second lookup for a rebinding DNS server to answer
 *     differently.
 *   - `guardedDownload` / `guardedGet` — a GET that follows redirects itself, re-checking
 *     every hop, stops reading once the body passes a byte cap, and gives up at a deadline.
 *     `pdf_read` downloads through it.
 *   - `ensureEgressProxy` — a loopback HTTP proxy that the headless browser is launched
 *     behind. Chromium follows redirects, loads subresources and runs page scripts on its
 *     own, so checking the first URL says nothing about the rest; sending all of its traffic
 *     through a proxy that connects via `guardedLookup` is the one place every request is seen.
 *
 * IP-literal hosts never reach a lookup function (the socket layer connects to them
 * directly), which is why every entry point also runs `blockedHostnameReason` first.
 */

import dns from 'node:dns'
import { createWriteStream } from 'node:fs'
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import https from 'node:https'
import net, { type AddressInfo, type LookupFunction } from 'node:net'
import { pipeline, Transform, type Duplex, type Readable } from 'node:stream'
import { pipeline as pipelineAsync } from 'node:stream/promises'
import zlib from 'node:zlib'
import { blockedAddressReason, blockedHostnameReason, isIpLiteral, normalizeHost, validateEgressUrl } from './egress-policy'

/** A request the policy refused. The message says which host or hop and why. */
export class EgressBlockedError extends Error {
	readonly code = 'EGRESS_BLOCKED'
	constructor(message: string) {
		super(message)
		this.name = 'EgressBlockedError'
	}
}

/** A response body larger than the caller's cap. */
export class EgressTooLargeError extends Error {
	readonly code = 'EGRESS_TOO_LARGE'
	constructor(message: string) {
		super(message)
		this.name = 'EgressTooLargeError'
	}
}

type Resolver = (
	hostname: string,
	options: dns.LookupAllOptions,
	callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void

/**
 * Build a `lookup` for `http.request` / `net.connect` that applies the policy to whatever
 * `resolve` returns. Exported with the resolver as a parameter so a spec can hand it a
 * name that "resolves" to a private address without a real DNS server; production code
 * uses `guardedLookup`, which resolves with `dns.lookup`.
 */
export function createGuardedLookup(resolve: Resolver = dns.lookup): LookupFunction {
	return (hostname, options, callback) => {
		const fail = (err: NodeJS.ErrnoException) => callback(err, '', 0)
		const hostReason = blockedHostnameReason(hostname)
		if (hostReason) {
			process.nextTick(fail, new EgressBlockedError(`Blocked: "${hostname}" is not a public address (${hostReason})`))
			return
		}
		resolve(hostname, { ...(options ?? {}), all: true }, (err, addresses) => {
			if (err) return fail(err)
			if (!addresses?.length) {
				return fail(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }))
			}
			// All of them, not just the first: which one the socket layer picks is not ours to
			// predict (happy-eyeballs races them), so one private answer taints the name.
			for (const { address } of addresses) {
				const reason = blockedAddressReason(address)
				if (reason) {
					return fail(new EgressBlockedError(`Blocked: "${hostname}" resolves to ${address} (${reason})`))
				}
			}
			if (options?.all) callback(null, addresses)
			else callback(null, addresses[0].address, addresses[0].family)
		})
	}
}

export const guardedLookup: LookupFunction = createGuardedLookup()

/**
 * Check a URL the way a request to it would be checked — shape, then every address its host
 * resolves to — without sending anything. Used before handing a URL to the browser so the
 * model gets a precise error; the proxy still enforces the same rule on every request.
 */
export async function assertPublicUrl(input: string | URL, lookup: LookupFunction = guardedLookup): Promise<URL> {
	const check = validateEgressUrl(input)
	if (!check.ok) throw new EgressBlockedError(check.error)
	const host = normalizeHost(check.url.hostname)
	if (!isIpLiteral(host)) {
		await new Promise<void>((resolve, reject) => {
			lookup(host, { all: true }, (err) => (err ? reject(err) : resolve()))
		})
	}
	return check.url
}

// ── Guarded GET ──────────────────────────────────────────────────────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_MAX_REDIRECTS = 5
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentStudio/1.0; +https://github.com/derekhearst/AgentStudio)'

export type GuardedGetOptions = {
	/** Hard cap on the (decoded) body. Declared lengths over it are refused before reading. */
	maxBytes: number
	/** One deadline for the whole exchange: every hop, and the body. */
	timeoutMs: number
	maxRedirects?: number
	headers?: Record<string, string>
	/**
	 * Test seam. Production callers leave it unset so every hop resolves through
	 * `guardedLookup`; a spec sets it to reach a fixture server on loopback, which the real
	 * policy (correctly) refuses.
	 */
	lookup?: LookupFunction
}

export type GuardedResponse = {
	/** Where the body actually came from, after redirects. */
	url: URL
	status: number
	headers: IncomingHttpHeaders
}

/** Errors once more than `maxBytes` have passed through. */
function byteCap(maxBytes: number, label: string): Transform {
	let seen = 0
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			seen += chunk.length
			if (seen > maxBytes) callback(new EgressTooLargeError(`${label} is larger than ${maxBytes} bytes`))
			else callback(null, chunk)
		},
	})
}

function decoderFor(encoding: string | undefined): Transform | null {
	switch ((encoding ?? '').trim().toLowerCase()) {
		case 'gzip':
		case 'x-gzip':
			return zlib.createGunzip()
		case 'deflate':
			return zlib.createInflate()
		case 'br':
			return zlib.createBrotliDecompress()
		default:
			return null
	}
}

/**
 * Follow redirects to a final response and return its body as a capped, decoded stream.
 * The deadline keeps running until that stream closes.
 */
async function openGuarded(input: string | URL, opts: GuardedGetOptions): Promise<GuardedResponse & { body: Readable }> {
	const first = validateEgressUrl(input)
	if (!first.ok) throw new EgressBlockedError(first.error)
	const lookup = opts.lookup ?? guardedLookup
	const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS

	// Whatever is in flight when the deadline passes gets destroyed with this error.
	let active: { destroy(err?: Error): unknown } | null = null
	let timedOut: Error | null = null
	const timer = setTimeout(() => {
		timedOut = new Error(`request timed out after ${opts.timeoutMs}ms`)
		active?.destroy(timedOut)
	}, opts.timeoutMs)
	timer.unref?.()

	try {
		let current = first.url
		for (let hop = 0; ; hop++) {
			// The deadline may have passed while the last redirect drained; nothing would then be
			// left to destroy the next request.
			if (timedOut) throw timedOut
			const res = await new Promise<IncomingMessage>((resolve, reject) => {
				const client = current.protocol === 'https:' ? https : http
				const req = client.request(
					current,
					{
						method: 'GET',
						headers: {
							'user-agent': USER_AGENT,
							accept: '*/*',
							'accept-encoding': 'gzip, deflate, br',
							...opts.headers,
						},
						lookup,
						// A pooled socket was opened by someone else's lookup; never reuse one.
						agent: false,
					},
					resolve,
				)
				active = req
				req.on('error', reject)
				req.end()
			})
			active = res
			if (timedOut) throw timedOut

			const status = res.statusCode ?? 0
			const location = res.headers.location
			if (REDIRECT_STATUSES.has(status) && location) {
				res.resume()
				if (hop >= maxRedirects) throw new Error(`too many redirects (more than ${maxRedirects})`)
				let target: URL
				try {
					target = new URL(location, current)
				} catch {
					throw new Error(`redirect to an invalid URL: ${location.slice(0, 200)}`)
				}
				const next = validateEgressUrl(target)
				if (!next.ok) throw new EgressBlockedError(`redirect from ${current.host} refused — ${next.error}`)
				current = next.url
				continue
			}

			const declared = Number(res.headers['content-length'])
			if (Number.isFinite(declared) && declared > opts.maxBytes) {
				res.destroy()
				throw new EgressTooLargeError(`response from ${current.host} is ${declared} bytes, over the ${opts.maxBytes}-byte cap`)
			}

			// The cap sits after the decoder, so a small compressed body cannot inflate past it.
			// Callback-form pipeline: an error anywhere tears every stage down and surfaces on
			// `cap`, which is the stream the caller reads.
			const decoder = decoderFor(res.headers['content-encoding'])
			const cap = byteCap(opts.maxBytes, `response from ${current.host}`)
			if (decoder) pipeline(res, decoder, cap, () => undefined)
			else pipeline(res, cap, () => undefined)
			active = cap
			cap.once('close', () => clearTimeout(timer))
			return { url: current, status, headers: res.headers, body: cap }
		}
	} catch (err) {
		clearTimeout(timer)
		;(active as { destroy(err?: Error): unknown } | null)?.destroy()
		throw timedOut ?? err
	}
}

/** GET a URL into memory, through the guard. For small bodies; `guardedDownload` streams. */
export async function guardedGet(input: string | URL, opts: GuardedGetOptions): Promise<GuardedResponse & { body: Buffer }> {
	const { body, ...meta } = await openGuarded(input, opts)
	const chunks: Buffer[] = []
	for await (const chunk of body) chunks.push(chunk as Buffer)
	return { ...meta, body: Buffer.concat(chunks) }
}

/**
 * GET a URL straight to a file, through the guard. Nothing is written for a non-2xx
 * response; the caller decides what that status means. A body over the cap is cut off
 * mid-stream and the partial file is left for the caller's temp-dir cleanup.
 */
export async function guardedDownload(
	input: string | URL,
	destPath: string,
	opts: GuardedGetOptions,
): Promise<GuardedResponse & { bytes: number }> {
	const { body, ...meta } = await openGuarded(input, opts)
	if (meta.status < 200 || meta.status >= 300) {
		body.destroy()
		return { ...meta, bytes: 0 }
	}
	const file = createWriteStream(destPath)
	await pipelineAsync(body, file)
	return { ...meta, bytes: file.bytesWritten }
}

// ── Egress proxy for the headless browser ────────────────────────────────────────

/**
 * Set on every response the proxy generates itself, carrying the reason. The browser tools
 * look for it on the main document so a refused navigation surfaces as an error instead of
 * as the text of the proxy's refusal page.
 */
export const EGRESS_REFUSAL_HEADER = 'x-agentstudio-egress-refused'

const HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'proxy-connection',
	'proxy-authorization',
	'proxy-authenticate',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]

function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
	const out = { ...headers }
	for (const name of HOP_BY_HOP) delete out[name]
	return out
}

/** Header values must be single-line printable ASCII. */
function headerSafe(message: string): string {
	return message.replace(/[^\x20-\x7e]/g, '?').slice(0, 300)
}

function refuse(res: http.ServerResponse, status: number, message: string) {
	if (res.headersSent) {
		res.destroy()
		return
	}
	res.writeHead(status, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		connection: 'close',
		[EGRESS_REFUSAL_HEADER]: headerSafe(message),
	})
	res.end(`AgentStudio did not load this address: ${message}\n`)
}

function refuseTunnel(socket: Duplex, status: number, message: string) {
	const reason = status === 403 ? 'Forbidden' : 'Bad Gateway'
	socket.end(`HTTP/1.1 ${status} ${reason}\r\n${EGRESS_REFUSAL_HEADER}: ${headerSafe(message)}\r\nConnection: close\r\n\r\n`)
}

/** Plain-HTTP requests arrive in absolute form (`GET http://host/path`). */
function forwardHttp(req: IncomingMessage, res: http.ServerResponse, lookup: LookupFunction) {
	if (!req.url || !/^http:\/\//i.test(req.url)) {
		refuse(res, 400, 'this proxy only forwards absolute http:// requests')
		return
	}
	const check = validateEgressUrl(req.url)
	if (!check.ok) {
		refuse(res, 403, check.error)
		return
	}
	const upstream = http.request(
		check.url,
		{ method: req.method, headers: withoutHopByHop(req.headers), lookup, agent: false },
		(up) => {
			res.writeHead(up.statusCode ?? 502, up.statusMessage, withoutHopByHop(up.headers))
			up.pipe(res)
		},
	)
	upstream.on('error', (err) => refuse(res, err instanceof EgressBlockedError ? 403 : 502, err.message))
	res.on('close', () => upstream.destroy())
	req.pipe(upstream)
}

/** `host:port` or `[v6]:port`, as a CONNECT request names its target. */
function parseAuthority(authority: string): { host: string; port: number } | null {
	const match = /^(\[[0-9a-f:.]+\]|[^\s:/@[\]]+):(\d{1,5})$/i.exec(authority)
	if (!match) return null
	const port = Number(match[2])
	if (port < 1 || port > 65535) return null
	try {
		// Let the URL parser canonicalise the host exactly as it would in a URL, so numeric
		// IPv4 spellings ("2130706433") come out as the dotted quad the policy understands.
		return { host: normalizeHost(new URL(`http://${match[1]}`).hostname), port }
	} catch {
		return null
	}
}

/** HTTPS and WebSocket traffic arrives as a CONNECT tunnel request. */
function tunnel(req: IncomingMessage, client: Duplex, head: Buffer, lookup: LookupFunction) {
	const target = parseAuthority(req.url ?? '')
	if (!target) {
		refuseTunnel(client, 403, 'malformed CONNECT target')
		return
	}
	const reason = blockedHostnameReason(target.host)
	if (reason) {
		refuseTunnel(client, 403, `Blocked: "${target.host}" is not a public address (${reason})`)
		return
	}
	let open = false
	const upstream = net.connect({ host: target.host, port: target.port, lookup })
	upstream.once('connect', () => {
		open = true
		client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
		if (head?.length) upstream.write(head)
		upstream.pipe(client)
		client.pipe(upstream)
	})
	upstream.on('error', (err) => {
		if (open) client.destroy()
		else refuseTunnel(client, err instanceof EgressBlockedError ? 403 : 502, err.message)
	})
	client.on('error', () => upstream.destroy())
	client.on('close', () => upstream.destroy())
}

export type EgressProxy = { url: string; close(): Promise<void> }

/**
 * Start a forward proxy on an ephemeral loopback port. It only ever connects to public
 * addresses, so another local process finding the port gains nothing it did not have.
 */
export async function createEgressProxy(options: { lookup?: LookupFunction } = {}): Promise<EgressProxy> {
	const lookup = options.lookup ?? guardedLookup
	const server = http.createServer((req, res) => forwardHttp(req, res, lookup))
	server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => tunnel(req, socket, head, lookup))
	server.on('clientError', (_err, socket) => socket.destroy())
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	// Never the reason the process stays alive.
	server.unref()
	const { port } = server.address() as AddressInfo
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.()
				server.close(() => resolve())
			}),
	}
}

let sharedProxy: Promise<EgressProxy> | null = null

/** The process-wide proxy the browser is launched behind, started on first use. */
export function ensureEgressProxy(): Promise<EgressProxy> {
	sharedProxy ??= createEgressProxy().catch((err) => {
		sharedProxy = null
		throw err
	})
	return sharedProxy
}
