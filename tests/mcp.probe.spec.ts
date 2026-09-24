import { expect, test } from '@playwright/test'
import { describeProbeFailure, probeMcpServer, redactSecrets, secretsIn, toolSnapshot } from '../src/lib/mcp/mcp-probe.server'
import { createGuardedFetch } from '../src/lib/tools/egress-fetch.server'
import { EgressTooLargeError } from '../src/lib/tools/egress.server'
import { fixtureLookup } from './egress-fixture'
import { startMcpFixture, type McpFixture } from './mcp-fixture'

/**
 * #17 — the connection test behind a connector's Test button (`src/lib/mcp/mcp-probe.server.ts`)
 * and the guarded fetch it makes every request through (`src/lib/tools/egress-fetch.server.ts`).
 *
 * No database and no dev server: each test starts the hand-written MCP server in
 * `./mcp-fixture` on loopback. The egress guard refuses loopback — that is the point of it — so
 * the tests that should reach the fixture call it `fixture.test` and hand the guard
 * `fixtureLookup` (`./egress-fixture`), which answers that one name with 127.0.0.1 and sends
 * every other name through the real policy. The tests that should be refused use no seam at all.
 *
 * What is pinned:
 *   - both transports connect, list every page of tools, and send the saved headers and token
 *   - a server that wants credentials, or refuses them, says so in words, as needsAuth
 *   - loopback, private names and redirects are refused before the server sees a request,
 *     unless the operator allowed that exact host
 *   - a stuck server costs the deadline, not the request
 *   - nothing a server echoes back leaks a token into the message the page shows
 */

const guarded = createGuardedFetch({ lookup: fixtureLookup })

const TOOLS = [
	{ name: 'search_issues', description: 'Search issues', annotations: { readOnlyHint: true, destructiveHint: false } },
	{ name: 'create_issue', title: 'Create an issue', description: 'Open a new issue' },
	{ name: 'delete_repo', annotations: { title: 'Delete a repository', destructiveHint: true } },
]

let fixture: McpFixture | null = null

test.afterEach(async () => {
	await fixture?.close()
	fixture = null
})

test.describe('a connection test that succeeds', () => {
	test('Streamable HTTP: connects, lists the tools and reports the server', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const result = await probeMcpServer({ transport: 'http', url: fixture.url('/mcp'), headers: {}, fetch: guarded })

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.tools.map((tool) => tool.name)).toEqual(['search_issues', 'create_issue', 'delete_repo'])
		expect(result.server).toEqual({ name: 'fixture-server', version: '1.2.3' })
		expect(fixture.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
	})

	test('SSE: connects over the event stream and lists the tools', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, token: 'sse-token' })
		const result = await probeMcpServer({
			transport: 'sse',
			url: fixture.url('/sse'),
			headers: { Authorization: 'Bearer sse-token' },
			fetch: guarded,
		})

		expect(result.ok, JSON.stringify(result)).toBe(true)
		if (!result.ok) return
		expect(result.tools).toHaveLength(3)
		expect(fixture.hits('/sse')).toBeGreaterThanOrEqual(1)
		expect(fixture.hits('/messages')).toBeGreaterThanOrEqual(2)
	})

	test('every request carries the saved token and headers', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, token: 'ghp_secret' })
		const result = await probeMcpServer({
			transport: 'http',
			url: fixture.url('/mcp'),
			headers: { Authorization: 'Bearer ghp_secret', 'X-Team': 'blue' },
			fetch: guarded,
		})

		expect(result.ok).toBe(true)
		const posts = fixture.requests.filter((r) => r.method === 'POST')
		expect(posts.length).toBeGreaterThanOrEqual(3)
		for (const request of posts) {
			expect(request.headers.authorization).toBe('Bearer ghp_secret')
			expect(request.headers['x-team']).toBe('blue')
		}
	})

	test('every page of tools is read', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, pageSize: 1 })
		const result = await probeMcpServer({ transport: 'http', url: fixture.url('/mcp'), headers: {}, fetch: guarded })

		expect(result.ok && result.tools.map((tool) => tool.name)).toEqual(['search_issues', 'create_issue', 'delete_repo'])
		expect(fixture.methods.filter((method) => method === 'tools/list')).toHaveLength(3)
	})

	test('a server that declares no tools capability is not asked for any', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, noToolsCapability: true })
		const result = await probeMcpServer({ transport: 'http', url: fixture.url('/mcp'), headers: {}, fetch: guarded })

		expect(result.ok && result.tools).toEqual([])
		expect(fixture.methods).not.toContain('tools/list')
	})

	test('a host the operator allowed is reached even though it is private', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		// No fetch seam: this is the production path, with MCP_ALLOWED_PRIVATE_HOSTS' exemption.
		const result = await probeMcpServer({
			transport: 'http',
			url: fixture.loopbackUrl('/mcp'),
			headers: {},
			allowedPrivateHosts: new Set(['127.0.0.1']),
		})

		expect(result.ok, JSON.stringify(result)).toBe(true)
	})
})

test.describe('a connection test that fails, in words', () => {
	test('no credentials: the server wants some', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, token: 'right' })
		const result = await probeMcpServer({ transport: 'http', url: fixture.url('/mcp'), headers: {}, fetch: guarded })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.needsAuth).toBe(true)
		expect(result.error).toMatch(/wants credentials \(401 Unauthorized\)/)
		expect(result.error).toMatch(/OAuth sign-in is not supported yet/)
	})

	test('the wrong token: the server refused it', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, token: 'right' })
		const result = await probeMcpServer({
			transport: 'http',
			url: fixture.url('/mcp'),
			headers: { Authorization: 'Bearer wrong' },
			fetch: guarded,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.needsAuth).toBe(true)
		expect(result.error).toMatch(/refused the credentials/)
	})

	test('the wrong token over SSE is a 401 too', async () => {
		fixture = await startMcpFixture({ tools: TOOLS, token: 'right' })
		const result = await probeMcpServer({
			transport: 'sse',
			url: fixture.url('/sse'),
			headers: { Authorization: 'Bearer wrong' },
			fetch: guarded,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.needsAuth).toBe(true)
	})

	test('a server that never answers costs the deadline, not the request', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const started = Date.now()
		const result = await probeMcpServer({
			transport: 'http',
			url: fixture.url('/slow'),
			headers: {},
			fetch: guarded,
			timeoutMs: 1_000,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toBe('No answer within 1 second.')
		expect(Date.now() - started).toBeLessThan(5_000)
	})

	test('a wrong path is a 404 that says where servers usually live', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const result = await probeMcpServer({ transport: 'http', url: fixture.url('/nope'), headers: {}, fetch: guarded })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.needsAuth).toBe(false)
		expect(result.error).toMatch(/Nothing answered at this URL \(404\).*\/mcp/)
	})

	test('a token the server echoes back in an error is not repeated', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const result = await probeMcpServer({
			transport: 'http',
			url: fixture.url('/boom'),
			headers: { Authorization: 'Bearer tok_very_secret_123' },
			fetch: guarded,
		})

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).not.toContain('tok_very_secret_123')
		expect(result.error).toContain('[redacted]')
	})
})

test.describe('the egress guard, in front of every request', () => {
	test('loopback is refused before the server sees anything', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const result = await probeMcpServer({ transport: 'http', url: fixture.loopbackUrl('/mcp'), headers: {} })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.needsAuth).toBe(false)
		expect(result.error).toMatch(/MCP_ALLOWED_PRIVATE_HOSTS/)
		expect(fixture.hits('/mcp')).toBe(0)
	})

	test('allowing one host allows only that host', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const result = await probeMcpServer({
			transport: 'http',
			url: fixture.loopbackUrl('/mcp'),
			headers: {},
			allowedPrivateHosts: new Set(['10.0.0.5', 'nas.local']),
		})

		expect(result.ok).toBe(false)
		expect(fixture.hits('/mcp')).toBe(0)
	})

	test('a public-looking name that resolves to a private address is refused at connect time', async () => {
		// `intranet.test` "resolves" to 10.1.2.3 in the fixture's DNS table.
		const result = await probeMcpServer({ transport: 'http', url: 'http://intranet.test/mcp', headers: {}, fetch: guarded })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toMatch(/resolves to 10\.1\.2\.3/)
		expect(result.error).toMatch(/MCP_ALLOWED_PRIVATE_HOSTS/)
	})

	test('a redirect is not followed', async () => {
		fixture = await startMcpFixture({ tools: TOOLS })
		const result = await probeMcpServer({ transport: 'http', url: fixture.url('/redirect'), headers: {}, fetch: guarded })

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toMatch(/redirected to http:\/\/intranet\.test\/mcp/)
		expect(result.error).toMatch(/Redirects are not followed/)
	})

	test('a response body over the cap is cut off', async () => {
		fixture = await startMcpFixture({ tools: Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(200) })) })
		const small = createGuardedFetch({ lookup: fixtureLookup, maxResponseBytes: 1_000 })
		const response = await small(fixture.url('/mcp'), {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		})

		expect(response.status).toBe(200)
		const err = await response.text().then(
			() => null,
			(e: unknown) => e,
		)
		expect(err).toBeInstanceOf(EgressTooLargeError)
	})

	test('only http and https are fetched', async () => {
		await expect(guarded('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/)
	})
})

test.describe('what the page is told', () => {
	test('a tool is reduced to its name, title, description and the server’s hints', () => {
		expect(toolSnapshot(TOOLS[0])).toEqual({
			name: 'search_issues',
			title: null,
			description: 'Search issues',
			readOnly: true,
			destructive: false,
			openWorld: null,
		})
		expect(toolSnapshot(TOOLS[2])).toMatchObject({ title: 'Delete a repository', destructive: true, readOnly: null })
		expect(toolSnapshot({ name: 'x', description: 'd'.repeat(2_000) })?.description?.length).toBeLessThanOrEqual(501)
	})

	test('a tool that could never carry a policy is left out, not listed under a clipped name', () => {
		// 128 characters is the longest name a policy is saved under; a clipped name would match
		// no call and fail validation for every policy save on the connector. Left out, it asks.
		expect(toolSnapshot({ name: 'a'.repeat(128) })?.name).toBe('a'.repeat(128))
		expect(toolSnapshot({ name: 'a'.repeat(129) })).toBeNull()
		expect(toolSnapshot({ name: '   ' })).toBeNull()
		expect(toolSnapshot({} as never)).toBeNull()
	})

	test('secrets are found in headers, a bearer token on its own too, and redacted longest first', () => {
		const secrets = secretsIn({ Authorization: 'Bearer abc123', 'X-Api-Key': 'key-999' })
		expect(secrets).toEqual(['Bearer abc123', 'abc123', 'key-999'])
		expect(redactSecrets('sent Bearer abc123 and abc123 and key-999', secrets)).toBe(
			'sent [redacted] and [redacted] and [redacted]',
		)
		// Too short to redact without shredding ordinary words.
		expect(redactSecrets('abc', ['abc'])).toBe('abc')
	})

	test('an unreachable address is described plainly', () => {
		const context = { transport: 'http' as const, sentCredentials: false, secrets: [] }
		expect(describeProbeFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), context).error).toMatch(
			/Nothing is listening/,
		)
		expect(describeProbeFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }), context).error).toMatch(/does not resolve/)
	})
})
