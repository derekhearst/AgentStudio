/**
 * Whether a connector (#17) that was still connecting when a turn began came up at all.
 *
 * `system/init` is the only MCP status the SDK volunteers, and it is usually too early to say
 * anything about a remote connector: the bundled CLI (0.3.278) starts MCP servers without
 * blocking the turn (`MCP_CONNECTION_NONBLOCKING` is on unless set to false), and AgentStudio
 * never sets `alwaysLoad`, so a remote server is normally still `pending` in init. One that
 * then fails — a 401, a refused connection, a wrong path — would never be reported, and its
 * tools would simply be missing.
 *
 * So once the turn is under way, this asks the session again: `Query.mcpServerStatus()`, the
 * SDK's `mcp_status` control request. It is only asked while the CLI's stdin is open — for a
 * chat turn, until the first `result`, when the SDK closes it — so never on the `result`
 * message itself. It asks only while some connector is unsettled (not yet reported as
 * connected, failed, needing a sign-in or disabled), at most every `minIntervalMs` and at most
 * `maxChecks` times, and each ask gives up after `timeoutMs`. A connector that fails after the
 * turn's last check goes unreported; the Test button on Settings → Connectors says why.
 *
 * Each connector is reported once per turn: one that init already reported as down (by
 * `./sdk-notices`) is not reported again. Only this run's connectors are watched — the names
 * it was given — so the list the CLI returns decides nothing else.
 *
 * Pure apart from the injected `readStatus` and clock, so specs drive it directly. Never
 * throws: it runs inside the run loop.
 */

import { mcpServersDown, mcpUnavailableNotice, type RunNotice } from './sdk-notices'

export type ConnectorStatusWatch = {
	/**
	 * Feed every SDK message the run loop sees, in order. Resolves to a notice to show — a
	 * connector that turned out to be unusable — or null. Resolves at once, without asking
	 * the session anything, for a run with no connectors or nothing left to check.
	 */
	observe(message: unknown): Promise<RunNotice | null>
}

export type ConnectorStatusWatchInput = {
	/** The keys this run's connectors were registered under — `RunMcpConnectors`' keys. */
	names: Iterable<string>
	/**
	 * Asks the live session for every MCP server's status (`Query.mcpServerStatus()`). Null
	 * when the session cannot be asked — a test double — which turns the watch off.
	 */
	readStatus: (() => Promise<unknown>) | null | undefined
	/** How long one ask may take before it is abandoned. */
	timeoutMs?: number
	/** The least time between two asks. */
	minIntervalMs?: number
	/** The most asks in one turn. */
	maxChecks?: number
	now?: () => number
}

export const CONNECTOR_STATUS_TIMEOUT_MS = 1_000
export const CONNECTOR_STATUS_MIN_INTERVAL_MS = 2_000
export const CONNECTOR_STATUS_MAX_CHECKS = 15

/** Statuses after which a connector needs no further checking this turn. */
const SETTLED = new Set(['connected', 'failed', 'needs-auth', 'disabled'])

/**
 * Messages that mean the turn is under way — the model is answering, a tool is running.
 * `system/init` is handled separately, and `result` is excluded: by the time it reaches the
 * loop the SDK has closed the CLI's stdin, so a control request would fail.
 */
const TURN_UNDER_WAY = new Set(['assistant', 'user', 'stream_event', 'tool_progress'])

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const NOTHING: Promise<null> = Promise.resolve(null)

export function watchConnectorStatus(input: ConnectorStatusWatchInput): ConnectorStatusWatch {
	const watched = new Set(input.names)
	const readStatus = input.readStatus
	if (watched.size === 0 || !readStatus) return { observe: () => NOTHING }

	const timeoutMs = input.timeoutMs ?? CONNECTOR_STATUS_TIMEOUT_MS
	const minIntervalMs = input.minIntervalMs ?? CONNECTOR_STATUS_MIN_INTERVAL_MS
	const maxChecks = input.maxChecks ?? CONNECTOR_STATUS_MAX_CHECKS
	const now = input.now ?? Date.now

	/** Not yet seen connected, down or disabled. Everything, until init says otherwise. */
	const unsettled = new Set(watched)
	/** Already named in a notice this turn — by init's, or by one of ours. */
	const reported = new Set<string>()
	let checks = 0
	let lastCheckAt: number | null = null

	/** Record what `list` says, and return this run's connectors that are newly down. */
	function settle(list: unknown) {
		if (!Array.isArray(list)) return []
		for (const entry of list) {
			const server = asRecord(entry)
			const name = typeof server?.name === 'string' ? server.name : null
			// `sdk` is our own in-process server; a connector is never that.
			if (!name || !watched.has(name) || server?.source === 'sdk') continue
			if (typeof server?.status === 'string' && SETTLED.has(server.status)) unsettled.delete(name)
		}
		const down = mcpServersDown(list).filter((server) => watched.has(server.name) && !reported.has(server.name))
		for (const server of down) reported.add(server.name)
		return down
	}

	async function ask(): Promise<unknown> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			return await Promise.race([
				readStatus!(),
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), timeoutMs)
				}),
			])
		} catch {
			// The session could not be asked — it ended, or the CLI refused. Nothing to report.
			return null
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	return {
		async observe(message) {
			try {
				const msg = asRecord(message)
				if (!msg) return null

				if (msg.type === 'system' && msg.subtype === 'init') {
					// `./sdk-notices` reports init's own failures; only remember them, so they are
					// not reported twice.
					settle(msg.mcp_servers)
					return null
				}

				if (typeof msg.type !== 'string' || !TURN_UNDER_WAY.has(msg.type)) return null
				if (unsettled.size === 0 || checks >= maxChecks) return null
				const at = now()
				if (lastCheckAt !== null && at - lastCheckAt < minIntervalMs) return null
				checks += 1
				lastCheckAt = at

				return mcpUnavailableNotice(settle(await ask()))
			} catch {
				return null
			}
		},
	}
}
