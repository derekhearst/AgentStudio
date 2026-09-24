/**
 * The connection test behind a connector's Test button (#17): connect, list the tools, hang up.
 *
 * This is its own MCP client, not the engine's. The SDK's `Query` handle can report and toggle
 * servers, but it lives for one turn of one chat — nothing a settings page can hold. So the test
 * uses the MCP TypeScript SDK's client with the same transport the connector is saved with, and
 * every request it makes goes through the egress guard (`createGuardedFetch`): the URL is
 * checked by spelling, every address the host resolves to is checked on the socket that is
 * used, redirects are refused, and the body is capped. The CLI connects with its own client
 * during a run, so a server can pass here and still fail there; the run says so with a notice.
 *
 * Never logs or returns a header value: an error message that happens to quote one has it
 * replaced before it leaves.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { EgressBlockedError, EgressTooLargeError } from '$lib/tools/egress.server'
import { createGuardedFetch, type GuardedFetch } from '$lib/tools/egress-fetch.server'
import type { McpToolSnapshot, McpTransport } from './mcp-config'

export const PROBE_TIMEOUT_MS = 10_000
const MAX_TOOL_PAGES = 20
const MAX_TOOLS = 500

export type McpProbeResult =
	| {
			ok: true
			tools: McpToolSnapshot[]
			server: { name: string; version: string } | null
	  }
	| {
			ok: false
			error: string
			/** The server wants credentials it did not get (or did not accept). */
			needsAuth: boolean
	  }

function noAnswerWithin(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000))
	return `No answer within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
}

class ProbeTimeoutError extends Error {
	constructor(ms: number) {
		super(noAnswerWithin(ms))
		this.name = 'ProbeTimeoutError'
	}
}

function clip(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null
	const text = value.trim()
	if (!text) return null
	return text.length > max ? `${text.slice(0, max)}…` : text
}

function hint(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null
}

type ListedTool = {
	name: string
	title?: string
	description?: string
	annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}

/** One `tools/list` entry, reduced to what the settings page shows. */
export function toolSnapshot(tool: ListedTool): McpToolSnapshot {
	return {
		name: clip(tool.name, 128) ?? '(unnamed)',
		title: clip(tool.title ?? tool.annotations?.title, 120),
		description: clip(tool.description, 500),
		readOnly: hint(tool.annotations?.readOnlyHint),
		destructive: hint(tool.annotations?.destructiveHint),
		openWorld: hint(tool.annotations?.openWorldHint),
	}
}

function statusOf(err: unknown): number | null {
	if (err instanceof StreamableHTTPError || err instanceof SseError) return typeof err.code === 'number' ? err.code : null
	return null
}

function errorCode(err: unknown): string | null {
	const code = (err as { code?: unknown } | null)?.code
	if (typeof code === 'string') return code
	const cause = (err as { cause?: { code?: unknown } } | null)?.cause
	return typeof cause?.code === 'string' ? cause.code : null
}

/** Replace any secret that turns up in `text` — a server may echo a header back in an error. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
	let out = text
	// Longest first, so a whole `Bearer <token>` goes before the token inside it.
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
		if (secret.length >= 4) out = out.split(secret).join('[redacted]')
	}
	return out
}

/** Every header value, and a bearer token on its own as well — a server may echo either. */
export function secretsIn(headers: Record<string, string>): string[] {
	const out: string[] = []
	for (const value of Object.values(headers)) {
		out.push(value)
		const token = /^Bearer\s+(.+)$/i.exec(value)?.[1]
		if (token) out.push(token)
	}
	return out
}

/** A failure, in words the operator can act on. */
export function describeProbeFailure(
	err: unknown,
	context: { transport: McpTransport; sentCredentials: boolean; secrets: readonly string[]; timeoutMs?: number },
): { error: string; needsAuth: boolean } {
	const status = statusOf(err)
	const message = err instanceof Error ? err.message : String(err)
	const code = errorCode(err)

	if (err instanceof UnauthorizedError || status === 401) {
		return {
			needsAuth: true,
			error: context.sentCredentials
				? 'The server refused the credentials (401 Unauthorized). Check the bearer token or header. A server that only accepts an OAuth sign-in is not supported yet.'
				: 'The server wants credentials (401 Unauthorized). Add a bearer token or the header it expects. A server that only accepts an OAuth sign-in is not supported yet.',
		}
	}
	if (status === 403) {
		return {
			needsAuth: true,
			error: 'The server answered 403 Forbidden: it recognised the request but will not allow it with these credentials.',
		}
	}
	if (status === 404) {
		return {
			needsAuth: false,
			error: `Nothing answered at this URL (404). Check the path — a ${context.transport === 'http' ? 'Streamable HTTP server usually lives at /mcp' : 'SSE server usually lives at /sse'}.`,
		}
	}
	if (status === 405 && context.transport === 'http') {
		return {
			needsAuth: false,
			error: 'The server does not take Streamable HTTP requests at this URL (405). If it is an older server, choose the SSE transport.',
		}
	}
	if (err instanceof EgressBlockedError) {
		return {
			needsAuth: false,
			error: `${message}. Connectors reach the public internet only, unless the server's operator lists the host in MCP_ALLOWED_PRIVATE_HOSTS.`,
		}
	}
	if (err instanceof EgressTooLargeError || err instanceof ProbeTimeoutError) {
		return { needsAuth: false, error: message }
	}
	// The MCP client's own per-request deadline, which is the same length as ours.
	if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
		return { needsAuth: false, error: noAnswerWithin(context.timeoutMs ?? PROBE_TIMEOUT_MS) }
	}
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
		return { needsAuth: false, error: 'The host name does not resolve. Check the URL.' }
	}
	if (code === 'ECONNREFUSED') {
		return { needsAuth: false, error: 'Nothing is listening at that address. Check the URL and the port.' }
	}
	const text = redactSecrets(message, context.secrets).replace(/\s+/g, ' ').trim()
	return {
		needsAuth: false,
		error: `The connection test failed: ${text.length > 300 ? `${text.slice(0, 300)}…` : text || 'no reason given'}`,
	}
}

/**
 * Connect to a server and list its tools. Never throws: a failure comes back as `ok: false`
 * with an explanation.
 *
 * `fetch` is a test seam. Production leaves it unset and gets the guarded fetch, with the
 * operator's `allowedPrivateHosts` exemption if any.
 */
export async function probeMcpServer(input: {
	transport: McpTransport
	url: string
	headers: Record<string, string>
	allowedPrivateHosts?: ReadonlySet<string>
	timeoutMs?: number
	fetch?: GuardedFetch
}): Promise<McpProbeResult> {
	const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS
	const secrets = secretsIn(input.headers)
	const context = { transport: input.transport, sentCredentials: secrets.length > 0, secrets, timeoutMs }

	let url: URL
	try {
		url = new URL(input.url)
	} catch {
		return { ok: false, needsAuth: false, error: 'That is not a valid URL.' }
	}

	// One deadline for the whole exchange. Aborting it tears down whatever is still open —
	// an SSE stream in particular, which would otherwise outlive the test.
	const deadline = new AbortController()
	const baseFetch = input.fetch ?? createGuardedFetch({ allowedPrivateHosts: input.allowedPrivateHosts })
	const fetchWithDeadline: GuardedFetch = (target, init) =>
		baseFetch(target, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal,
		})
	const transportOptions = { requestInit: { headers: input.headers }, fetch: fetchWithDeadline }
	const transport =
		input.transport === 'http'
			? new StreamableHTTPClientTransport(url, transportOptions)
			: new SSEClientTransport(url, transportOptions)
	const client = new Client({ name: 'AgentStudio', version: '1.0.0' }, { capabilities: {} })

	const work = (async (): Promise<McpProbeResult> => {
		await client.connect(transport, { timeout: timeoutMs })
		const tools: McpToolSnapshot[] = []
		// A server that declares no tools capability has none to list; asking would be an error.
		if (client.getServerCapabilities()?.tools) {
			let cursor: string | undefined
			for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS; page++) {
				const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs })
				for (const tool of result.tools) {
					if (tools.length >= MAX_TOOLS) break
					tools.push(toolSnapshot(tool as ListedTool))
				}
				cursor = result.nextCursor
				if (!cursor) break
			}
		}
		const info = client.getServerVersion()
		return {
			ok: true,
			tools,
			server: info ? { name: clip(info.name, 100) ?? 'unknown', version: clip(info.version, 50) ?? '' } : null,
		}
	})()
	// Whichever loses the race below must not surface as an unhandled rejection.
	work.catch(() => undefined)

	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs)
		})
		return await Promise.race([work, timeout])
	} catch (err) {
		return { ok: false, ...describeProbeFailure(err, context) }
	} finally {
		clearTimeout(timer)
		deadline.abort()
		await client.close().catch(() => undefined)
	}
}
