/**
 * Connectors (#17): the `mcp_servers` rows — reading, writing, testing, and loading the enabled
 * ones for a chat run.
 *
 * Secrets go in encrypted and never come out to the page. Every read the settings page makes
 * leaves `encrypted_secrets` unselected and reports only which headers are set and whether a
 * bearer token is; the plaintext exists in memory only to build a run's server config or to run
 * a connection test.
 *
 * Nothing here is reachable by an agent: no tool and no `/api/mcp` route exposes it. A run that
 * could add a connector could connect a server to itself — the same self-escalation that keeps
 * `local` settings out of `$lib/engine/setting-sources`.
 */

import type { LookupFunction } from 'node:net'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { getPostgresErrorCode } from '$lib/db/migrations.server'
import { decryptSecret, encryptSecret, hasEncryptionKey } from '$lib/source-control/encryption.server'
import { recordAuditEvent } from '$lib/governance/governance.server'
import { UserInputError } from '$lib/server/user-input-error'
import { logger } from '$lib/observability/logger'
import { EgressBlockedError, assertPublicUrl } from '$lib/tools/egress.server'
import { normalizeHost } from '$lib/tools/egress-policy'
import {
	buildRunMcpConnectors,
	connectorDisallowedTools,
	type ExternalMcpInput,
	type RunMcpConnectors,
} from '$lib/engine/mcp-connectors'
import type { RunNotice } from '$lib/engine/sdk-notices'
import { mcpServers, type McpServerRow } from './mcp.schema'
import {
	EMPTY_SECRETS,
	MAX_CONNECTOR_TIMEOUT_MS,
	MIN_CONNECTOR_TIMEOUT_MS,
	applySecretsPatch,
	checkMcpUrl,
	connectorNameProblem,
	connectorRequestHeaders,
	connectorSecretsProblem,
	hasSecrets,
	normalizeToolPolicies,
	parseAllowedPrivateHosts,
	parseSecrets,
	serializeSecrets,
	toSdkServerConfig,
	type ConnectorSecrets,
	type ConnectorSecretsPatch,
	type ConnectorServerConfig,
	type McpToolPolicy,
	type McpToolSnapshot,
	type McpTransport,
} from './mcp-config'
import { probeMcpServer, type McpProbeResult } from './mcp-probe.server'

/** `MCP_ALLOWED_PRIVATE_HOSTS`, read per call so a restart is all a change needs. */
export function connectorAllowedPrivateHosts(): Set<string> {
	return parseAllowedPrivateHosts(process.env.MCP_ALLOWED_PRIVATE_HOSTS)
}

// ─────────── What the settings page sees ───────────

export type McpServerView = {
	id: string
	name: string
	label: string
	transport: McpTransport
	url: string
	enabled: boolean
	timeoutMs: number | null
	/** Names only. The values stay encrypted. */
	headerNames: string[]
	hasBearerToken: boolean
	toolPolicies: Record<string, McpToolPolicy>
	tools: McpToolSnapshot[]
	lastTestedAt: Date | null
	lastTestOk: boolean | null
	lastError: string | null
	createdAt: Date
	updatedAt: Date
}

/** Every column except `encrypted_secrets`, which never leaves this module. */
const viewColumns = {
	id: mcpServers.id,
	name: mcpServers.name,
	label: mcpServers.label,
	transport: mcpServers.transport,
	url: mcpServers.url,
	enabled: mcpServers.enabled,
	timeoutMs: mcpServers.timeoutMs,
	headerNames: mcpServers.headerNames,
	hasBearerToken: mcpServers.hasBearerToken,
	toolPolicies: mcpServers.toolPolicies,
	tools: mcpServers.toolsSnapshot,
	lastTestedAt: mcpServers.lastTestedAt,
	lastTestOk: mcpServers.lastTestOk,
	lastError: mcpServers.lastError,
	createdAt: mcpServers.createdAt,
	updatedAt: mcpServers.updatedAt,
}

function toView(row: McpServerRow): McpServerView {
	return {
		id: row.id,
		name: row.name,
		label: row.label,
		transport: row.transport,
		url: row.url,
		enabled: row.enabled,
		timeoutMs: row.timeoutMs,
		headerNames: row.headerNames,
		hasBearerToken: row.hasBearerToken,
		toolPolicies: row.toolPolicies,
		tools: row.toolsSnapshot,
		lastTestedAt: row.lastTestedAt,
		lastTestOk: row.lastTestOk,
		lastError: row.lastError,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

export async function listMcpServers(userId: string): Promise<McpServerView[]> {
	return db.select(viewColumns).from(mcpServers).where(eq(mcpServers.userId, userId)).orderBy(asc(mcpServers.createdAt))
}

async function ownedRow(userId: string, id: string): Promise<McpServerRow> {
	const [row] = await db
		.select()
		.from(mcpServers)
		.where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
		.limit(1)
	if (!row) throw new UserInputError('That connector no longer exists.')
	return row
}

// ─────────── Validation and secrets ───────────

function checkedLabel(label: string): string {
	const trimmed = String(label ?? '').trim()
	if (!trimmed) throw new UserInputError('A connector needs a label.')
	if (trimmed.length > 80) throw new UserInputError('A connector label is at most 80 characters.')
	return trimmed
}

function checkedUrl(url: string): string {
	const check = checkMcpUrl(url, connectorAllowedPrivateHosts())
	if (!check.ok) throw new UserInputError(check.error)
	return check.url.href
}

function checkedTimeout(timeoutMs: number | null | undefined): number | null {
	if (timeoutMs === null || timeoutMs === undefined) return null
	if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_CONNECTOR_TIMEOUT_MS || timeoutMs > MAX_CONNECTOR_TIMEOUT_MS) {
		throw new UserInputError(
			`The call timeout is between ${MIN_CONNECTOR_TIMEOUT_MS / 1000} and ${MAX_CONNECTOR_TIMEOUT_MS / 1000} seconds.`,
		)
	}
	return timeoutMs
}

/** The columns that hold a connector's secrets: the encrypted document and what the page may see of it. */
function sealSecrets(secrets: ConnectorSecrets): Pick<McpServerRow, 'encryptedSecrets' | 'headerNames' | 'hasBearerToken'> {
	const problem = connectorSecretsProblem(secrets)
	if (problem) throw new UserInputError(problem)
	if (!hasSecrets(secrets)) return { encryptedSecrets: null, headerNames: [], hasBearerToken: false }
	if (!hasEncryptionKey()) {
		throw new UserInputError(
			'APP_ENCRYPTION_KEY is not set on this server, so a token or header cannot be stored. Set it and restart, or connect a server that needs no credentials.',
		)
	}
	return {
		encryptedSecrets: encryptSecret(serializeSecrets(secrets)),
		headerNames: Object.keys(secrets.headers).sort((a, b) => a.localeCompare(b)),
		hasBearerToken: secrets.bearerToken !== null,
	}
}

/** Throws when the stored document cannot be decrypted (a missing or changed key). */
function openSecrets(row: Pick<McpServerRow, 'encryptedSecrets'>): ConnectorSecrets {
	if (!row.encryptedSecrets) return { ...EMPTY_SECRETS, headers: {} }
	return parseSecrets(decryptSecret(row.encryptedSecrets))
}

/** What the audit trail records about a connector. Names, never values; the URL without its query. */
function auditState(row: McpServerRow): Record<string, unknown> {
	let url = row.url
	try {
		const parsed = new URL(row.url)
		url = `${parsed.origin}${parsed.pathname}`
	} catch {
		// Stored URLs were validated; keep whatever is there.
	}
	return {
		name: row.name,
		label: row.label,
		transport: row.transport,
		url,
		enabled: row.enabled,
		timeoutMs: row.timeoutMs,
		headerNames: row.headerNames,
		hasBearerToken: row.hasBearerToken,
		toolPolicies: row.toolPolicies,
	}
}

// ─────────── Writes ───────────

export type CreateMcpServerInput = {
	label: string
	name: string
	transport: McpTransport
	url: string
	enabled?: boolean
	timeoutMs?: number | null
	bearerToken?: string | null
	headers?: Record<string, string>
}

export async function createMcpServer(userId: string, input: CreateMcpServerInput): Promise<McpServerView> {
	const name = String(input.name ?? '').trim()
	const nameProblem = connectorNameProblem(name)
	if (nameProblem) throw new UserInputError(nameProblem)
	const secrets = applySecretsPatch(EMPTY_SECRETS, { bearerToken: input.bearerToken, headers: input.headers })

	let row: McpServerRow
	try {
		;[row] = await db
			.insert(mcpServers)
			.values({
				userId,
				name,
				label: checkedLabel(input.label),
				transport: input.transport,
				url: checkedUrl(input.url),
				enabled: input.enabled ?? true,
				timeoutMs: checkedTimeout(input.timeoutMs),
				...sealSecrets(secrets),
			})
			.returning()
	} catch (err) {
		if (getPostgresErrorCode(err) === '23505') throw new UserInputError(`You already have a connector named "${name}".`)
		throw err
	}
	await recordAuditEvent({
		actorUserId: userId,
		action: 'mcp_server.created',
		targetType: 'mcp_server',
		targetId: row.id,
		afterState: auditState(row),
		summary: `Connected ${row.label} (${row.name})`,
	})
	return toView(row)
}

/**
 * An edit. The name is not editable: renaming would rename every tool (`mcp__<name>__*`) and
 * cut the usage ledger's history for them in two.
 *
 * The secrets follow `ConnectorSecretsPatch`: a field left blank keeps what is stored.
 */
export type UpdateMcpServerInput = {
	label?: string
	transport?: McpTransport
	url?: string
	timeoutMs?: number | null
} & ConnectorSecretsPatch

export async function updateMcpServer(userId: string, id: string, patch: UpdateMcpServerInput): Promise<McpServerView> {
	const row = await ownedRow(userId, id)
	const changes: Partial<McpServerRow> = {}
	if (patch.label !== undefined) changes.label = checkedLabel(patch.label)
	if (patch.transport !== undefined) changes.transport = patch.transport
	if (patch.url !== undefined) changes.url = checkedUrl(patch.url)
	if (patch.timeoutMs !== undefined) changes.timeoutMs = checkedTimeout(patch.timeoutMs)

	const touchesSecrets = patch.bearerToken !== undefined || Object.keys(patch.headers ?? {}).length > 0
	if (touchesSecrets) {
		let current: ConnectorSecrets
		try {
			current = openSecrets(row)
		} catch (err) {
			// Unreadable with this key, so useless as it is: start from nothing, and the operator
			// re-enters what the server needs.
			logger.warn('[mcp] stored connector secrets could not be decrypted; replacing them', {
				connectorId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
			current = { ...EMPTY_SECRETS, headers: {} }
		}
		Object.assign(changes, sealSecrets(applySecretsPatch(current, patch)))
	}

	// A different address or different credentials make the last test say nothing about now.
	const connectionChanged =
		(changes.transport !== undefined && changes.transport !== row.transport) ||
		(changes.url !== undefined && changes.url !== row.url) ||
		touchesSecrets
	if (connectionChanged) {
		changes.lastTestedAt = null
		changes.lastTestOk = null
		changes.lastError = null
	}

	const [updated] = await db
		.update(mcpServers)
		.set({ ...changes, updatedAt: new Date() })
		.where(and(eq(mcpServers.id, row.id), eq(mcpServers.userId, userId)))
		.returning()
	const changed = Object.keys(changes).filter((key) => !['lastTestedAt', 'lastTestOk', 'lastError', 'encryptedSecrets'].includes(key))
	await recordAuditEvent({
		actorUserId: userId,
		action: 'mcp_server.updated',
		targetType: 'mcp_server',
		targetId: row.id,
		beforeState: auditState(row),
		afterState: auditState(updated),
		summary: `Edited ${updated.label}: ${changed.length > 0 ? changed.join(', ') : 'no changes'}`,
	})
	return toView(updated)
}

export async function setMcpServerEnabled(userId: string, id: string, enabled: boolean): Promise<McpServerView> {
	const row = await ownedRow(userId, id)
	const [updated] = await db
		.update(mcpServers)
		.set({ enabled, updatedAt: new Date() })
		.where(and(eq(mcpServers.id, row.id), eq(mcpServers.userId, userId)))
		.returning()
	await recordAuditEvent({
		actorUserId: userId,
		action: 'mcp_server.updated',
		targetType: 'mcp_server',
		targetId: row.id,
		beforeState: auditState(row),
		afterState: auditState(updated),
		summary: `${enabled ? 'Enabled' : 'Disabled'} ${updated.label}`,
	})
	return toView(updated)
}

/** Replace a connector's per-tool policy. `ask` entries are dropped: a tool with no entry asks. */
export async function setMcpToolPolicies(userId: string, id: string, policies: Record<string, unknown>): Promise<McpServerView> {
	const row = await ownedRow(userId, id)
	const toolPolicies = normalizeToolPolicies(policies)
	const [updated] = await db
		.update(mcpServers)
		.set({ toolPolicies, updatedAt: new Date() })
		.where(and(eq(mcpServers.id, row.id), eq(mcpServers.userId, userId)))
		.returning()
	const counts = Object.values(toolPolicies).reduce(
		(acc, policy) => ({ ...acc, [policy]: (acc[policy] ?? 0) + 1 }),
		{} as Record<string, number>,
	)
	await recordAuditEvent({
		actorUserId: userId,
		action: 'mcp_server.updated',
		targetType: 'mcp_server',
		targetId: row.id,
		beforeState: { toolPolicies: row.toolPolicies },
		afterState: { toolPolicies },
		summary: `Tool policy for ${updated.label}: ${counts.allow ?? 0} allowed, ${counts.block ?? 0} blocked, the rest ask`,
	})
	return toView(updated)
}

export async function deleteMcpServer(userId: string, id: string): Promise<{ id: string }> {
	const row = await ownedRow(userId, id)
	await db.delete(mcpServers).where(and(eq(mcpServers.id, row.id), eq(mcpServers.userId, userId)))
	await recordAuditEvent({
		actorUserId: userId,
		action: 'mcp_server.deleted',
		targetType: 'mcp_server',
		targetId: row.id,
		beforeState: auditState(row),
		summary: `Removed ${row.label} (${row.name})`,
	})
	return { id: row.id }
}

// ─────────── Test ───────────

async function runConnectionTest(row: McpServerRow, probe: typeof probeMcpServer): Promise<McpProbeResult> {
	const hosts = connectorAllowedPrivateHosts()
	// Checked again: the stored URL passed when it was saved, but the allowed hosts may have changed.
	const url = checkMcpUrl(row.url, hosts)
	if (!url.ok) return { ok: false, needsAuth: false, error: url.error }
	let secrets: ConnectorSecrets
	try {
		secrets = openSecrets(row)
	} catch {
		return {
			ok: false,
			needsAuth: true,
			error: 'The stored token or headers could not be decrypted (was APP_ENCRYPTION_KEY changed?). Enter them again.',
		}
	}
	return probe({
		transport: row.transport,
		url: url.url.href,
		headers: connectorRequestHeaders(secrets),
		allowedPrivateHosts: hosts,
	})
}

/**
 * Run the connection test against the saved configuration and record the outcome. A success
 * replaces the stored tool list; a failure keeps the last one, so the policies stay editable.
 *
 * `probe` is a test seam; production uses `probeMcpServer`.
 */
export async function testMcpServer(
	userId: string,
	id: string,
	deps: { probe?: typeof probeMcpServer } = {},
): Promise<{ server: McpServerView; result: McpProbeResult }> {
	const row = await ownedRow(userId, id)
	const outcome = await runConnectionTest(row, deps.probe ?? probeMcpServer)
	const [updated] = await db
		.update(mcpServers)
		.set({
			lastTestedAt: new Date(),
			lastTestOk: outcome.ok,
			lastError: outcome.ok ? null : outcome.error,
			...(outcome.ok ? { toolsSnapshot: outcome.tools } : {}),
		})
		.where(and(eq(mcpServers.id, row.id), eq(mcpServers.userId, userId)))
		.returning()
	return { server: toView(updated), result: outcome }
}

// ─────────── Run start ───────────

export type SkippedConnector = { name: string; reason: string }

export type RunMcpServers = ExternalMcpInput & {
	/** Every connector the run was given, with its per-tool policy. Empty when it was given none. */
	connectors: RunMcpConnectors
	/** Enabled connectors left out of this run, and why. */
	skipped: SkippedConnector[]
	/** One notice for the chat when anything was skipped. */
	notices: RunNotice[]
}

function noConnectors(skipped: SkippedConnector[] = []): RunMcpServers {
	return {
		servers: {},
		disallowedTools: [],
		connectors: new Map(),
		skipped,
		notices: skipped.length > 0 ? [skippedNotice(skipped)] : [],
	}
}

/** The notice the chat shows when an enabled connector was left out of the turn. */
export function skippedNotice(skipped: SkippedConnector[]): RunNotice {
	const detail = skipped
		.slice(0, 5)
		.map((s) => `${s.name}: ${s.reason}`)
		.join(' · ')
	return {
		kind: 'mcp_unavailable',
		level: 'warn',
		title: skipped.length === 1 ? 'A connector was left out of this turn' : `${skipped.length} connectors were left out of this turn`,
		detail: skipped.length > 5 ? `${detail} · and ${skipped.length - 5} more` : detail,
		persist: false,
	}
}

/** How long run start waits for a connector's host name to resolve before leaving it out. */
const RUN_RESOLVE_TIMEOUT_MS = 3_000

/**
 * Why this run should not connect to `url`'s host, or null.
 *
 * The CLI makes a run's connections itself, with its own client — the egress guard never sees
 * them. So before a connector is handed over, its host is resolved here under the guard's rule:
 * a name that resolves to a private, loopback or metadata address is left out, exactly as the
 * Test button would refuse it. A host the operator listed in `MCP_ALLOWED_PRIVATE_HOSTS` is
 * exempt, as everywhere else. This narrows the window rather than closing it — the CLI resolves
 * the name again when it connects — and docs/mcp/mcp.md says so.
 */
async function hostProblem(url: URL, allowedPrivateHosts: ReadonlySet<string>, lookup?: LookupFunction): Promise<string | null> {
	if (allowedPrivateHosts.has(normalizeHost(url.hostname))) return null
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			assertPublicUrl(url, lookup),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('timed out')), RUN_RESOLVE_TIMEOUT_MS)
			}),
		])
		return null
	} catch (err) {
		if (err instanceof EgressBlockedError) {
			return `${err.message}. Connectors reach the public internet only, unless the server's operator lists the host in MCP_ALLOWED_PRIVATE_HOSTS.`
		}
		return 'its host name did not resolve'
	} finally {
		clearTimeout(timer)
	}
}

/**
 * The connectors a chat run gets: every enabled row of the user's, as SDK server configs, plus
 * the per-tool policy the engine's gate applies and the blocked tools the model is not shown.
 *
 * Only an interactive chat run (`chat_stream`) whose agent has no fixed tool list gets any.
 * Anywhere else nobody can answer the approval a connector's tool asks for, so every call would
 * be refused and the servers would only cost context; and a fixed tool list would refuse their
 * tools anyway.
 *
 * Never throws. A row that cannot be used — its URL no longer passes, its host resolves to a
 * private address, its secrets cannot be decrypted — is left out with a reason, and the run goes
 * ahead without it.
 *
 * `lookup` is a test seam for the host check; production resolves through the egress guard.
 */
export async function loadRunMcpServers(
	input: {
		userId: string
		runSource: string
		toolScoped: boolean
	},
	deps: { lookup?: LookupFunction } = {},
): Promise<RunMcpServers> {
	if (input.runSource !== 'chat_stream' || input.toolScoped) return noConnectors()

	let rows: McpServerRow[]
	try {
		rows = await db
			.select()
			.from(mcpServers)
			.where(and(eq(mcpServers.userId, input.userId), eq(mcpServers.enabled, true)))
			.orderBy(asc(mcpServers.createdAt))
	} catch (err) {
		logger.warn('[mcp] could not load connectors for a run', { error: err instanceof Error ? err.message : String(err) })
		return noConnectors([{ name: 'connectors', reason: 'could not be loaded from the database' }])
	}

	const hosts = connectorAllowedPrivateHosts()
	// Every row is judged in parallel, then kept in the order the page lists them.
	const judged = await Promise.all(
		rows.map(async (row): Promise<{ row: McpServerRow; config: ConnectorServerConfig } | SkippedConnector> => {
			if (connectorNameProblem(row.name) !== null) {
				return { name: row.label, reason: 'its name is not a valid connector name' }
			}
			const url = checkMcpUrl(row.url, hosts)
			if (!url.ok) return { name: row.name, reason: url.error }
			let secrets: ConnectorSecrets
			try {
				secrets = openSecrets(row)
			} catch {
				return { name: row.name, reason: 'its stored token or headers could not be decrypted' }
			}
			const unreachable = await hostProblem(url.url, hosts, deps.lookup)
			if (unreachable) return { name: row.name, reason: unreachable }
			return {
				row,
				config: toSdkServerConfig(
					{ transport: row.transport, url: url.url.href, timeoutMs: row.timeoutMs },
					connectorRequestHeaders(secrets),
				),
			}
		}),
	)

	const servers: Record<string, ConnectorServerConfig> = {}
	const loaded: McpServerRow[] = []
	const skipped: SkippedConnector[] = []
	for (const outcome of judged) {
		if ('reason' in outcome) {
			skipped.push(outcome)
			continue
		}
		servers[outcome.row.name] = outcome.config
		loaded.push(outcome.row)
	}

	const connectors = buildRunMcpConnectors(loaded)
	return {
		servers,
		disallowedTools: connectorDisallowedTools(connectors),
		connectors,
		skipped,
		notices: skipped.length > 0 ? [skippedNotice(skipped)] : [],
	}
}
