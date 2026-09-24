/**
 * Connectors (#17): the operator's own MCP servers, as one run sees them.
 *
 * A connector is a row in `mcp_servers` — an HTTP or SSE MCP server the operator added on
 * Settings → Connectors. At run start `$lib/mcp/mcp.server` loads the enabled rows and hands
 * this module two things: the SDK configs (merged into `Options.mcpServers` beside our own
 * in-process server) and each row's per-tool policy (allow / ask / block). The engine's tool
 * gate reads the policy through `connectorCallVerdict`.
 *
 * ## Trust is keyed on the row, never on a name the server chose
 *
 * A call arrives as `mcp__<server>__<tool>`. The server half is the key *we* registered the
 * connector under — validated, reserved names refused, unique per user, immutable — and the
 * tool half is whatever the server published. So:
 *
 *   - a policy is looked up by (the run's connector row for that key, the tool name), and a
 *     call whose server key is not one of this run's rows is refused outright;
 *   - the SDK's provenance for the call (`canUseTool`'s `mcpServer`, the PreToolUse hook's
 *     `mcp_server`) must agree: source `dynamic` — what the CLI reports for a server passed in
 *     `Options.mcpServers` — and the same key. Anything else is refused. `strictMcpConfig`
 *     (see `./options.server`) means nothing else should ever appear; this is the check that
 *     notices if it does;
 *   - with no provenance reported at all, `allow` is downgraded to `ask`: a call we cannot
 *     tie to its row is never run unasked.
 *
 * Pure: no database, no SvelteKit, no `$lib`, so specs import it directly.
 */

import type { McpHttpServerConfig, McpSSEServerConfig, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { OWN_MCP_SERVER, isExternalToolPolicy, parseToolNamespace, type ExternalToolPolicy } from './permission-mode'

export type ConnectorServerConfig = McpHttpServerConfig | McpSSEServerConfig

// ─────────── Names ───────────

/**
 * What a connector may be called. Lower-case letters and digits in hyphen-separated runs, at
 * most 32 characters.
 *
 * Two reasons for something this narrow. The CLI rewrites every character outside
 * `[a-zA-Z0-9_-]` to `_` when it builds a tool name (checked in the bundled CLI, 0.3.278), so
 * a name inside this set is the name the tools arrive under. And with no underscores at all,
 * `mcp__<name>__<tool>` splits in exactly one place — the CLI splits on the first `__`, and
 * so does `parseToolNamespace`.
 */
export const CONNECTOR_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const CONNECTOR_NAME_MAX_LENGTH = 32

/**
 * Keys no connector may take: ours, and the ones the CLI uses for servers of its own
 * (`workspace`, `ide`, `memory`, `hearthbot`, and the `claude…` family), seen in the bundled
 * CLI. A connector under one of those would at best be shadowed and at worst be mistaken for
 * something it is not.
 */
export const RESERVED_CONNECTOR_NAMES: readonly string[] = [OWN_MCP_SERVER, 'workspace', 'ide', 'memory', 'hearthbot']

/** Why `name` cannot be a connector's key, or null when it can. */
export function connectorNameProblem(name: string): string | null {
	if (!name) return 'A connector needs a name.'
	if (name.length > CONNECTOR_NAME_MAX_LENGTH) return `A connector name is at most ${CONNECTOR_NAME_MAX_LENGTH} characters.`
	if (!CONNECTOR_NAME_PATTERN.test(name)) {
		return 'A connector name uses lower-case letters and digits, separated by single hyphens (for example "github" or "my-tracker").'
	}
	if (RESERVED_CONNECTOR_NAMES.includes(name) || name.startsWith('claude')) {
		return `"${name}" is reserved. Pick another name.`
	}
	return null
}

/**
 * A tool name the way the CLI spells it inside `mcp__<server>__<tool>`: every character outside
 * `[a-zA-Z0-9_-]` becomes `_`. Mirrors the bundled CLI's own normaliser, so a policy saved
 * against the name `tools/list` reported can be found again from the name a call arrives under.
 */
export function cliToolNameSegment(name: string): string {
	return String(name ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

// ─────────── The run's connectors ───────────

export type RunMcpConnector = {
	/** The `mcp_servers` row this connector is. Trust is keyed on it. */
	id: string
	/** The key it was registered under — the `<server>` in `mcp__<server>__<tool>`. */
	name: string
	/** Per-tool policy, keyed by `cliToolNameSegment(tool)`. A tool not in here asks. */
	policies: ReadonlyMap<string, ExternalToolPolicy>
}

/** Keyed by connector name. */
export type RunMcpConnectors = ReadonlyMap<string, RunMcpConnector>

const STRICTNESS: Record<ExternalToolPolicy, number> = { allow: 0, ask: 1, block: 2 }

/** The stricter of two policies — for two tool names that the CLI would spell the same way. */
export function stricterPolicy(a: ExternalToolPolicy, b: ExternalToolPolicy): ExternalToolPolicy {
	return STRICTNESS[a] >= STRICTNESS[b] ? a : b
}

/**
 * Build the run's connector map from the loaded rows. A row whose name would not pass
 * `connectorNameProblem` is left out (it cannot have been saved through the settings page, and
 * merging it could shadow something), and so is a policy value that is not one of the three.
 */
export function buildRunMcpConnectors(
	rows: ReadonlyArray<{ id: string; name: string; toolPolicies?: Record<string, unknown> | null }>,
): RunMcpConnectors {
	const out = new Map<string, RunMcpConnector>()
	for (const row of rows) {
		if (connectorNameProblem(row.name) !== null || out.has(row.name)) continue
		const policies = new Map<string, ExternalToolPolicy>()
		for (const [tool, value] of Object.entries(row.toolPolicies ?? {})) {
			if (!isExternalToolPolicy(value)) continue
			const key = cliToolNameSegment(tool)
			const existing = policies.get(key)
			policies.set(key, existing ? stricterPolicy(existing, value) : value)
		}
		out.set(row.name, { id: row.id, name: row.name, policies })
	}
	return out
}

/** The full name of every tool a connector blocks — for `Options.disallowedTools`. */
export function connectorDisallowedTools(connectors: RunMcpConnectors): string[] {
	const names: string[] = []
	for (const connector of connectors.values()) {
		for (const [tool, policy] of connector.policies) {
			if (policy === 'block') names.push(`mcp__${connector.name}__${tool}`)
		}
	}
	return names
}

// ─────────── One call ───────────

/** The SDK's `McpServerProvenance` for a call: which server, and where its definition came from. */
export type McpProvenance = { name: string; source: string }

/**
 * The provenance source the CLI reports for a server passed through `Options.mcpServers` (it
 * goes to the CLI as `--mcp-config`). From the SDK's own typings: "`dynamic` for
 * --mcp-config / `mcp_set_servers` process servers".
 */
export const CONNECTOR_PROVENANCE_SOURCE = 'dynamic'

export type ConnectorCallVerdict =
	/** A call to one of this run's connectors: what its row says for this tool. */
	| { kind: 'policy'; policy: ExternalToolPolicy; connectorId: string }
	/** Not one of this run's connectors, or the SDK says it came from somewhere else. */
	| { kind: 'refused'; reason: string }

function clipName(name: string): string {
	const safe = String(name ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
	return safe.length > 64 ? `${safe.slice(0, 64)}…` : safe
}

/**
 * Decide a call to an external tool against the run's connectors. Null for a name that is not
 * external (a built-in, or one of ours), which this has nothing to say about.
 *
 * `provenance`:
 *
 *   an object   what the SDK reported for this call — checked against the row;
 *   null        the SDK reported nothing (a CLI that predates the field): `allow` asks instead;
 *   undefined   nothing has been reported *yet*. Only the engine's frame decision passes this —
 *               it picks which card the chat shows when the model announces a call, before the
 *               SDK has said anything. It never decides a call: the PreToolUse hook and
 *               `canUseTool` decide again, with what the SDK reported.
 */
export function connectorCallVerdict(
	connectors: RunMcpConnectors,
	toolName: string,
	provenance: McpProvenance | null | undefined,
): ConnectorCallVerdict | null {
	const { server, bare } = parseToolNamespace(toolName)
	if (server === null || server === OWN_MCP_SERVER) return null

	const connector = connectors.get(server)
	if (!connector) {
		return {
			kind: 'refused',
			reason: `"${clipName(server)}" is not a connector configured for this run, so its tools are refused. Connectors are added on Settings → Connectors.`,
		}
	}
	if (provenance) {
		const matches = provenance.source === CONNECTOR_PROVENANCE_SOURCE && provenance.name === connector.name
		if (!matches) {
			return {
				kind: 'refused',
				reason: `This call claims to come from the connector "${clipName(server)}", but the engine reports it from a different server (${clipName(provenance.name)}, source ${clipName(provenance.source)}), so it is refused.`,
			}
		}
	}

	let policy = connector.policies.get(cliToolNameSegment(bare)) ?? 'ask'
	if (provenance === null && policy === 'allow') policy = 'ask'
	return { kind: 'policy', policy, connectorId: connector.id }
}

// ─────────── Options ───────────

/** What `buildEngineOptions` takes from the connectors: the server configs and the blocked tools. */
export type ExternalMcpInput = {
	servers: Readonly<Record<string, ConnectorServerConfig>>
	disallowedTools: readonly string[]
}

/**
 * `Options.mcpServers`: the connectors, then our own server.
 *
 * Ours goes last so no connector key can shadow it, and any external entry under our name (or
 * any name `connectorNameProblem` refuses) is dropped rather than trusted. A run whose agent
 * has a fixed tool list (`scoped`) gets no connectors at all: its scope would refuse their
 * tools anyway, and every connector costs context.
 */
export function composeMcpServers(input: {
	own: McpServerConfig
	external?: Readonly<Record<string, ConnectorServerConfig>> | null
	scoped: boolean
}): Record<string, McpServerConfig> {
	const servers: Record<string, McpServerConfig> = {}
	if (!input.scoped && input.external) {
		for (const [name, config] of Object.entries(input.external)) {
			if (connectorNameProblem(name) !== null) continue
			servers[name] = config
		}
	}
	servers[OWN_MCP_SERVER] = input.own
	return servers
}
