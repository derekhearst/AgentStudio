/**
 * Connectors (#17) — the rules a connector's configuration has to meet, as pure functions.
 *
 * A connector is an HTTP or SSE MCP server the operator adds on Settings → Connectors. This
 * module validates what the form sends (name, URL, headers, bearer token, timeout, per-tool
 * policy), shapes the secrets that are stored encrypted, and builds the config the Claude Agent
 * SDK is handed. No database, no SvelteKit, no `node:` imports: the settings form runs the same
 * name check in the browser, and the specs import it directly.
 *
 * Stdio servers are deliberately not a transport here. A stdio server is a child process of the
 * CLI, outside the shell sandbox, with the CLI's environment — the database URL and the
 * encryption key among it for a Claude run. See docs/mcp/mcp.md.
 */

import { normalizeHost, validateEgressUrl } from '../tools/egress-policy'
import { CONNECTOR_NAME_MAX_LENGTH, connectorNameProblem, type ConnectorServerConfig } from '../engine/mcp-connectors'
import { EXTERNAL_TOOL_POLICIES, isExternalToolPolicy, type ExternalToolPolicy } from '../engine/permission-mode'

export { CONNECTOR_NAME_MAX_LENGTH, connectorNameProblem, type ConnectorServerConfig }

// ─────────── Transport ───────────

export const MCP_TRANSPORTS = ['http', 'sse'] as const

export type McpTransport = (typeof MCP_TRANSPORTS)[number]

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
	http: 'Streamable HTTP',
	sse: 'SSE (older servers)',
}

// ─────────── Policy ───────────

export const MCP_TOOL_POLICIES = EXTERNAL_TOOL_POLICIES

export type McpToolPolicy = ExternalToolPolicy

export const MCP_TOOL_POLICY_LABELS: Record<McpToolPolicy, string> = {
	allow: 'Allow',
	ask: 'Ask',
	block: 'Block',
}

/** At most this many per-tool entries on one connector. */
export const MAX_TOOL_POLICIES = 500

/**
 * The stored form of a connector's per-tool policy: only `allow` and `block` entries, because a
 * tool without an entry asks. Unknown values and over-long names are dropped.
 */
export function normalizeToolPolicies(input: Record<string, unknown> | null | undefined): Record<string, McpToolPolicy> {
	const out: Record<string, McpToolPolicy> = {}
	let count = 0
	for (const [rawName, value] of Object.entries(input ?? {})) {
		const name = rawName.trim()
		if (!name || name.length > 128 || !isExternalToolPolicy(value) || value === 'ask') continue
		if (count >= MAX_TOOL_POLICIES) break
		out[name] = value
		count += 1
	}
	return out
}

// ─────────── Name ───────────

/** A starting point for the name field, from the label: "GitHub Issues" → "github-issues". */
export function suggestConnectorName(label: string): string {
	return String(label ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, CONNECTOR_NAME_MAX_LENGTH)
		.replace(/-+$/g, '')
}

// ─────────── URL ───────────

export const MCP_URL_MAX_LENGTH = 2000

export type McpUrlCheck =
	| {
			ok: true
			url: URL
			/** Plain `http:` — a token or header would travel unencrypted. */
			cleartext: boolean
	  }
	| { ok: false; error: string }

/**
 * The operator's escape hatch for a server on their own network: `MCP_ALLOWED_PRIVATE_HOSTS`,
 * a comma- or space-separated list of host names or addresses. Read from the deployment's
 * environment only — nothing a run or the settings page can change.
 */
export function parseAllowedPrivateHosts(raw: string | null | undefined): Set<string> {
	const hosts = new Set<string>()
	for (const part of String(raw ?? '').split(/[\s,]+/)) {
		const host = normalizeHost(part)
		if (host) hosts.add(host)
	}
	return hosts
}

/**
 * Whether `input` can be a connector's URL.
 *
 * http(s) only, no credentials in the URL (they would be stored and shown in plain text — the
 * bearer token and the headers are the encrypted fields), and a host on the public internet,
 * by the same rule the web tools' egress guard applies (`$lib/tools/egress-policy`). A host the
 * operator listed in `MCP_ALLOWED_PRIVATE_HOSTS` is exempt from that last rule, and only it.
 *
 * This is the spelling check. The Test button also checks what the name resolves to, through the
 * guard itself.
 */
export function checkMcpUrl(input: string, allowedPrivateHosts: ReadonlySet<string> = new Set()): McpUrlCheck {
	const raw = String(input ?? '').trim()
	if (!raw) return { ok: false, error: 'A connector needs a URL.' }
	if (raw.length > MCP_URL_MAX_LENGTH) return { ok: false, error: `The URL is longer than ${MCP_URL_MAX_LENGTH} characters.` }

	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return { ok: false, error: 'That is not a valid URL.' }
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'A connector URL starts with https:// (or http://).' }
	}
	if (url.username || url.password) {
		return {
			ok: false,
			error: 'Put credentials in the bearer token or a header, not in the URL — the URL is stored and shown in plain text.',
		}
	}
	if (!allowedPrivateHosts.has(normalizeHost(url.hostname))) {
		const egress = validateEgressUrl(url)
		if (!egress.ok) {
			return {
				ok: false,
				error: `${egress.error}. Connectors reach the public internet only, unless the server's operator lists the host in MCP_ALLOWED_PRIVATE_HOSTS.`,
			}
		}
	}
	return { ok: true, url, cleartext: url.protocol === 'http:' }
}

// ─────────── Headers and token ───────────

export const MAX_CONNECTOR_HEADERS = 20

/** Bytes, not characters: this is what goes on the wire. */
export const MAX_HEADER_VALUE_BYTES = 8192

/** RFC 9110 `token`. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Headers the connection or the MCP transport owns. A connector setting one would either break
 * the protocol (`content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`) or smuggle
 * something past the connection layer (`host`, `content-length`, the hop-by-hop set).
 */
export const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
	'host',
	'content-length',
	'content-type',
	'accept',
	'accept-encoding',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'te',
	'trailer',
	'upgrade',
	'proxy-authorization',
	'proxy-authenticate',
	'proxy-connection',
	'mcp-session-id',
	'mcp-protocol-version',
	'last-event-id',
])

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length
}

export function headerNameProblem(name: string): string | null {
	if (!name) return 'A header needs a name.'
	if (name.length > 128) return `Header name "${name.slice(0, 40)}…" is too long.`
	if (!HEADER_NAME.test(name)) return `"${name}" is not a valid header name.`
	if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) return `The "${name}" header is set by the connection itself.`
	return null
}

export function headerValueProblem(name: string, value: string): string | null {
	if (/[\r\n\0]/.test(value)) return `The value of "${name}" contains a line break.`
	if (byteLength(value) > MAX_HEADER_VALUE_BYTES) return `The value of "${name}" is longer than ${MAX_HEADER_VALUE_BYTES} bytes.`
	return null
}

export function bearerTokenProblem(token: string): string | null {
	if (!token) return 'The bearer token is empty.'
	if (/\s/.test(token)) return 'A bearer token has no spaces or line breaks. Paste the token alone, without "Bearer ".'
	if (byteLength(token) > MAX_HEADER_VALUE_BYTES) return `The bearer token is longer than ${MAX_HEADER_VALUE_BYTES} bytes.`
	return null
}

/** What a connector's stored secrets decrypt to. */
export type ConnectorSecrets = {
	bearerToken: string | null
	headers: Record<string, string>
}

export const EMPTY_SECRETS: ConnectorSecrets = { bearerToken: null, headers: {} }

/** Why this set of secrets cannot be saved, or null. */
export function connectorSecretsProblem(secrets: ConnectorSecrets): string | null {
	if (secrets.bearerToken !== null) {
		const problem = bearerTokenProblem(secrets.bearerToken)
		if (problem) return problem
	}
	const names = Object.keys(secrets.headers)
	if (names.length > MAX_CONNECTOR_HEADERS) return `A connector has at most ${MAX_CONNECTOR_HEADERS} headers.`
	const seen = new Set<string>()
	for (const name of names) {
		const nameProblem = headerNameProblem(name)
		if (nameProblem) return nameProblem
		const lower = name.toLowerCase()
		if (seen.has(lower)) return `The "${name}" header is listed twice.`
		seen.add(lower)
		if (lower === 'authorization' && secrets.bearerToken !== null) {
			return 'Use either the bearer token or an Authorization header, not both.'
		}
		const valueProblem = headerValueProblem(name, secrets.headers[name])
		if (valueProblem) return valueProblem
	}
	return null
}

export function hasSecrets(secrets: ConnectorSecrets): boolean {
	return secrets.bearerToken !== null || Object.keys(secrets.headers).length > 0
}

/** The plaintext that gets encrypted into `mcp_servers.encrypted_secrets`. */
export function serializeSecrets(secrets: ConnectorSecrets): string {
	return JSON.stringify({ v: 1, bearerToken: secrets.bearerToken, headers: secrets.headers })
}

/** The inverse of `serializeSecrets`. Anything malformed comes back as no secrets at all. */
export function parseSecrets(plaintext: string): ConnectorSecrets {
	try {
		const parsed = JSON.parse(plaintext) as { bearerToken?: unknown; headers?: unknown }
		const headers: Record<string, string> = {}
		if (parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers)) {
			for (const [name, value] of Object.entries(parsed.headers as Record<string, unknown>)) {
				if (typeof value === 'string') headers[name] = value
			}
		}
		const bearerToken = typeof parsed.bearerToken === 'string' && parsed.bearerToken ? parsed.bearerToken : null
		return { bearerToken, headers }
	} catch {
		return { ...EMPTY_SECRETS, headers: {} }
	}
}

/**
 * An edit to the secrets, the way the form sends it. The form never receives a stored value, so
 * a blank field has to mean "leave it":
 *
 *   omitted, or ''   keep what is stored
 *   null             remove it
 *   any other text   replace it
 */
export type ConnectorSecretsPatch = {
	bearerToken?: string | null
	headers?: Record<string, string | null>
}

export function applySecretsPatch(current: ConnectorSecrets, patch: ConnectorSecretsPatch): ConnectorSecrets {
	let bearerToken = current.bearerToken
	if (patch.bearerToken === null) bearerToken = null
	else if (typeof patch.bearerToken === 'string' && patch.bearerToken.trim() !== '') bearerToken = patch.bearerToken.trim()

	const headers: Record<string, string> = { ...current.headers }
	for (const [rawName, value] of Object.entries(patch.headers ?? {})) {
		const name = rawName.trim()
		// Header names are case-insensitive: an edit to "x-api-key" replaces a stored "X-Api-Key".
		const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
		if (value === null) {
			if (existing !== undefined) delete headers[existing]
			continue
		}
		if (value === '') continue
		if (existing !== undefined) delete headers[existing]
		headers[name] = value
	}
	return { bearerToken, headers }
}

/** The headers every request to the server carries: the custom ones, and the bearer token. */
export function connectorRequestHeaders(secrets: ConnectorSecrets): Record<string, string> {
	return {
		...secrets.headers,
		...(secrets.bearerToken ? { Authorization: `Bearer ${secrets.bearerToken}` } : {}),
	}
}

// ─────────── Timeout ───────────

/** The SDK ignores a per-call timeout under a second; ten minutes is more than any tool call should take. */
export const MIN_CONNECTOR_TIMEOUT_MS = 1_000
export const MAX_CONNECTOR_TIMEOUT_MS = 600_000

// ─────────── The SDK's config ───────────

/**
 * The entry that goes into `Options.mcpServers` under the connector's name.
 *
 * `alwaysLoad` is never set: it makes the CLI hold the turn until the server connects, and a
 * slow connector should cost its own tools, not the whole turn.
 */
export function toSdkServerConfig(
	connector: { transport: McpTransport; url: string; timeoutMs: number | null },
	headers: Record<string, string>,
): ConnectorServerConfig {
	const hasHeaders = Object.keys(headers).length > 0
	const timeout = connector.timeoutMs ?? undefined
	return {
		type: connector.transport,
		url: connector.url,
		...(hasHeaders ? { headers } : {}),
		...(timeout ? { timeout } : {}),
	}
}

// ─────────── What a server offers ───────────

/**
 * One tool as the connection test saw it (`tools/list`). The annotations are the server's own
 * claims — shown to the operator as hints, never used to decide anything.
 */
export type McpToolSnapshot = {
	name: string
	title: string | null
	description: string | null
	readOnly: boolean | null
	destructive: boolean | null
	openWorld: boolean | null
}
