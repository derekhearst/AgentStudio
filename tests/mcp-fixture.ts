/**
 * A small MCP server for the connector specs (`mcp.probe.spec.ts`) — #17.
 *
 * Written by hand rather than with the MCP SDK's server classes so every answer is fixed and
 * visible here: which requests arrived, with which headers, and what each got back. It speaks
 * just enough of both transports the connection test uses:
 *
 *   /mcp        Streamable HTTP. POST carries one JSON-RPC message and is answered with JSON
 *               (202 for a notification); GET and DELETE are 405, which the spec allows a
 *               server that offers no standalone event stream to answer.
 *   /sse        The older HTTP+SSE transport. GET opens the event stream and names the POST
 *               endpoint; each POST to /messages is accepted with 202 and answered on the stream.
 *
 * Plus the misbehaviours the spec needs: `/redirect` (302 to a private name), `/slow` (never
 * answers), `/boom` (a 500 that echoes the request's credentials back).
 *
 * It listens on loopback, which the egress guard refuses, so specs reach it as `fixture.test`
 * through `fixtureLookup` (`./egress-fixture`) — or as 127.0.0.1 with that host allowed.
 */

import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { FIXTURE_HOST } from './egress-fixture'

export type FixtureTool = {
	name: string
	title?: string
	description?: string
	annotations?: Record<string, unknown>
}

export type McpFixtureOptions = {
	/** When set, every request must carry `Authorization: Bearer <token>` or gets a 401. */
	token?: string
	tools?: FixtureTool[]
	/** `tools/list` answers this many per page, with a cursor for the rest. Default: all at once. */
	pageSize?: number
	/** Declare no `tools` capability at all. */
	noToolsCapability?: boolean
}

export type McpFixture = {
	/** `http://fixture.test:<port><path>` — reached through `fixtureLookup`. */
	url(path: string): string
	/** `http://127.0.0.1:<port><path>` — refused unless the host is allowed. */
	loopbackUrl(path: string): string
	/** Requests to `path` since start. */
	hits(path: string): number
	/** The JSON-RPC methods received, in order, across both transports. */
	methods: string[]
	/** The headers of every request received, in order. */
	requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>
	close(): Promise<void>
}

type JsonRpc = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, unknown> }

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString('utf8')
}

export async function startMcpFixture(options: McpFixtureOptions = {}): Promise<McpFixture> {
	const tools = (options.tools ?? []).map((tool) => ({ inputSchema: { type: 'object', properties: {} }, ...tool }))
	const hits = new Map<string, number>()
	const methods: string[] = []
	const requests: McpFixture['requests'] = []
	const streams = new Map<string, http.ServerResponse>()
	let nextStream = 0

	/** The answer to one JSON-RPC message, or null for a notification. */
	function answer(message: JsonRpc): Record<string, unknown> | null {
		if (message.method) methods.push(message.method)
		if (message.id === undefined || message.id === null) return null
		const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result })
		switch (message.method) {
			case 'initialize':
				return reply({
					protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
					capabilities: options.noToolsCapability ? {} : { tools: {} },
					serverInfo: { name: 'fixture-server', version: '1.2.3' },
				})
			case 'tools/list': {
				const size = options.pageSize ?? tools.length
				const start = Number(message.params?.cursor ?? 0)
				const page = tools.slice(start, start + Math.max(1, size))
				const next = start + page.length < tools.length ? String(start + page.length) : undefined
				return reply({ tools: page, ...(next ? { nextCursor: next } : {}) })
			}
			case 'ping':
				return reply({})
			default:
				return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
		}
	}

	function authorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		if (!options.token || req.headers.authorization === `Bearer ${options.token}`) return true
		res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
		res.end(JSON.stringify({ error: 'unauthorized' }))
		return false
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://fixture')
		const path = url.pathname
		hits.set(path, (hits.get(path) ?? 0) + 1)
		requests.push({ method: req.method ?? '', path, headers: req.headers })

		if (path === '/redirect') {
			res.writeHead(302, { location: 'http://intranet.test/mcp' })
			res.end()
			return
		}
		if (path === '/slow') return // never answered
		if (path === '/boom') {
			await readBody(req)
			res.writeHead(500, { 'content-type': 'text/plain' })
			res.end(`upstream rejected token ${String(req.headers.authorization ?? '').replace(/^Bearer /, '')}`)
			return
		}

		if (path === '/mcp') {
			if (req.method !== 'POST') {
				res.writeHead(405, { allow: 'POST' })
				res.end()
				return
			}
			if (!authorized(req, res)) return
			const reply = answer(JSON.parse(await readBody(req)) as JsonRpc)
			if (!reply) {
				res.writeHead(202)
				res.end()
				return
			}
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(reply))
			return
		}

		if (path === '/sse' && req.method === 'GET') {
			if (!authorized(req, res)) return
			const id = String(nextStream++)
			streams.set(id, res)
			res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
			res.write(`event: endpoint\ndata: /messages?session=${id}\n\n`)
			req.on('close', () => streams.delete(id))
			return
		}

		if (path === '/messages' && req.method === 'POST') {
			if (!authorized(req, res)) return
			const stream = streams.get(url.searchParams.get('session') ?? '')
			const message = JSON.parse(await readBody(req)) as JsonRpc
			if (!stream) {
				res.writeHead(404)
				res.end()
				return
			}
			res.writeHead(202)
			res.end()
			const reply = answer(message)
			if (reply) stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
			return
		}

		res.writeHead(404)
		res.end()
	})

	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const { port } = server.address() as AddressInfo

	return {
		url: (path) => `http://${FIXTURE_HOST}:${port}${path}`,
		loopbackUrl: (path) => `http://127.0.0.1:${port}${path}`,
		hits: (path) => hits.get(path) ?? 0,
		methods,
		requests,
		close: async () => {
			for (const stream of streams.values()) stream.end()
			server.closeAllConnections()
			server.close()
			await once(server, 'close').catch(() => undefined)
		},
	}
}
