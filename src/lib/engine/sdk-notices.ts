/**
 * Turns the SDK messages the engine used to drop into something a person can read.
 *
 * `stream.server.ts` handled five of the thirty-odd members of `SDKMessage`:
 * `thinking_tokens`, `stream_event`, `assistant`, `user` and `result`. Everything else fell
 * through the loop and vanished — which is why a run that was retrying a failed API call,
 * waiting on a rate limit, compacting its context, or having a tool refused by a permission
 * rule looked, from the chat, exactly like a run that had silently stopped doing anything.
 *
 * Three things come out of here:
 *
 * - **Notices** — timeline events worth a line in the transcript. Each carries whether it is
 *   worth *persisting*: a compaction boundary is history a reader needs months later, an
 *   API retry is noise once the turn succeeds.
 * - **Background tasks** — the live set, with REPLACE semantics straight from the SDK ("swap
 *   your set for this payload"), not a delta to merge.
 * - **Tool progress** — elapsed seconds for an in-flight call. The SDK sends no partial
 *   output with these, so this is what makes a spinner honest, not a stream (#26).
 *
 * Everything is read defensively. These shapes evolve with the CLI behind the SDK, the loop
 * sees `Record<string, any>`, and an unrecognised message must return null so the engine
 * ignores it exactly as it did before. Never throws: this runs inside the run loop.
 *
 * Pure and dependency-free, like `./builtin-tools` and `./tool-result-details`.
 */

export type RunNoticeKind =
	| 'compacted'
	| 'api_retry'
	| 'model_fallback'
	| 'model_refused'
	| 'permission_denied'
	| 'rate_limit'
	| 'worker_shutdown'
	| 'task_finished'
	/** A connector (#17) the run was given is not usable this turn. */
	| 'mcp_unavailable'

export type RunNoticeLevel = 'info' | 'warn' | 'error'

export type RunNotice = {
	kind: RunNoticeKind
	level: RunNoticeLevel
	/** One line, already written for a reader. Never raw JSON. */
	title: string
	/** Optional second line. Model-authored or API-authored prose — display only. */
	detail: string | null
	/**
	 * Whether this belongs in the persisted transcript.
	 *
	 * The test is whether it still means something after the turn succeeds. A compaction
	 * explains why earlier messages are summarised; a refused tool explains a gap in the
	 * work. A retry that then worked explains nothing, and a transcript full of them is how
	 * a notice channel becomes something people learn to ignore.
	 */
	persist: boolean
}

/** One live background task, as the SDK reports it. */
export type BackgroundTask = {
	id: string
	/** The SDK's `task_type`, e.g. a backgrounded Bash command or a background agent. */
	type: string
	description: string
}

export type SdkInterpretation =
	| { kind: 'notice'; notice: RunNotice }
	/** REPLACE semantics: this is the whole live set, not a delta. */
	| { kind: 'background_tasks'; tasks: BackgroundTask[] }
	| { kind: 'tool_progress'; toolUseId: string; elapsedSeconds: number }

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Cap prose we did not write. `api_refusal_explanation` is explicitly unstable human text. */
const MAX_DETAIL_CHARS = 400

function detail(value: unknown): string | null {
	const text = str(value)
	if (!text) return null
	return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text
}

function notice(
	kind: RunNoticeKind,
	level: RunNoticeLevel,
	title: string,
	detailText: string | null,
	persist: boolean,
): SdkInterpretation {
	return { kind: 'notice', notice: { kind, level, title, detail: detailText, persist } }
}

/** "1,024 → 312 tokens" reads better than either number alone. */
function compactionTitle(meta: Record<string, unknown> | null): string {
	const before = num(meta?.pre_tokens)
	const after = num(meta?.post_tokens)
	const manual = meta?.trigger === 'manual'
	const how = manual ? 'Context compacted' : 'Context compacted automatically'
	if (before === null) return how
	return after === null
		? `${how} from ${before.toLocaleString()} tokens`
		: `${how}: ${before.toLocaleString()} → ${after.toLocaleString()} tokens`
}

function backgroundTasks(value: unknown): BackgroundTask[] {
	if (!Array.isArray(value)) return []
	const tasks: BackgroundTask[] = []
	for (const entry of value) {
		const task = asRecord(entry)
		const id = str(task?.task_id)
		if (!id) continue
		// `ambient` marks watchers and other non-activity tasks; the SDK says hosts should
		// leave them out of activity indicators, and a chip is an activity indicator.
		if (task?.ambient === true) continue
		tasks.push({
			id,
			type: str(task?.task_type) ?? 'task',
			description: str(task?.description) ?? 'Background task',
		})
	}
	return tasks
}

/** Statuses in `system/init`'s `mcp_servers` that mean a server's tools are not there. */
const UNAVAILABLE_MCP_STATUS: Record<string, string> = {
	failed: 'could not connect',
	'needs-auth': 'needs a sign-in',
}

/**
 * The connectors that `system/init` reports as unusable, or null when they all came up.
 *
 * Only servers that are not our own in-process one (`source: 'sdk'`) count — those are the
 * operator's connectors (#17). `pending` is not a failure: MCP startup does not block the turn,
 * so a slow server is still connecting when init is sent. Server names are the configuration's
 * keys, which the SDK calls untrusted text; they are reduced to their safe characters and
 * clipped before they reach a notice.
 */
function mcpUnavailableNotice(msg: Record<string, unknown>): SdkInterpretation | null {
	if (!Array.isArray(msg.mcp_servers)) return null
	const down: string[] = []
	for (const entry of msg.mcp_servers) {
		const server = asRecord(entry)
		const name = str(server?.name)
		const status = str(server?.status)
		if (!name || !status || server?.source === 'sdk') continue
		const why = UNAVAILABLE_MCP_STATUS[status]
		if (!why) continue
		down.push(`${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)} (${why})`)
	}
	if (down.length === 0) return null
	const shown = down.slice(0, 5).join(', ') + (down.length > 5 ? `, and ${down.length - 5} more` : '')
	return notice(
		'mcp_unavailable',
		'warn',
		down.length === 1 ? 'A connector is unavailable this turn' : `${down.length} connectors are unavailable this turn`,
		`${shown}. Their tools are missing from this turn; test the connection on Settings → Connectors.`,
		true,
	)
}

function systemNotice(subtype: string, msg: Record<string, unknown>): SdkInterpretation | null {
	switch (subtype) {
		case 'init':
			return mcpUnavailableNotice(msg)

		case 'compact_boundary':
			return notice('compacted', 'info', compactionTitle(asRecord(msg.compact_metadata)), null, true)

		case 'api_retry': {
			const attempt = num(msg.attempt)
			const max = num(msg.max_retries)
			const status = num(msg.error_status)
			const where = attempt !== null && max !== null ? ` (attempt ${attempt} of ${max})` : ''
			return notice(
				'api_retry',
				'warn',
				`Retrying after an API error${status !== null ? ` ${status}` : ''}${where}`,
				null,
				// Transient by construction: if the retry works the run is fine, and if it does
				// not the failure surfaces on its own.
				false,
			)
		}

		case 'model_fallback':
		case 'model_refusal_fallback': {
			const from = str(msg.original_model)
			const to = str(msg.fallback_model)
			const local = msg.scope === 'local'
			return notice(
				'model_fallback',
				'warn',
				from && to
					? `${local ? 'One reply' : 'This session'} fell back from ${from} to ${to}`
					: 'The model fell back to a different model',
				detail(msg.api_refusal_explanation),
				true,
			)
		}

		case 'model_refusal_no_fallback':
			return notice(
				'model_refused',
				'error',
				`${str(msg.original_model) ?? 'The model'} refused the request and no fallback was available`,
				detail(msg.api_refusal_explanation) ?? detail(msg.content),
				true,
			)

		case 'permission_denied': {
			const tool = str(msg.tool_name) ?? 'A tool'
			// Ours already render as `tool_denied`; this one is the CLI's own rules refusing,
			// which otherwise looks like the model simply deciding not to act.
			return notice(
				'permission_denied',
				'warn',
				`${tool} was refused by a permission rule`,
				detail(msg.decision_reason),
				true,
			)
		}

		case 'worker_shutting_down':
			return notice(
				'worker_shutdown',
				'error',
				'The model worker is shutting down; this turn may end early',
				detail(msg.reason),
				true,
			)

		case 'background_tasks_changed':
			return { kind: 'background_tasks', tasks: backgroundTasks(msg.tasks) }

		case 'task_notification': {
			const status = msg.status
			const summary = detail(msg.summary)
			// `worker_restart` is the one machine-readable cause, and it means the task was
			// orphaned rather than that it failed on its own terms.
			const orphaned = msg.reason === 'worker_restart'
			if (status === 'completed') {
				return notice('task_finished', 'info', 'A background task finished', summary, true)
			}
			if (status === 'stopped') {
				return notice(
					'task_finished',
					'warn',
					orphaned ? 'A background task was lost to a worker restart' : 'A background task was stopped',
					summary,
					true,
				)
			}
			if (status === 'failed') {
				return notice('task_finished', 'error', 'A background task failed', summary, true)
			}
			return null
		}

		default:
			return null
	}
}

/**
 * Interpret one SDK message, or return null to leave it alone.
 *
 * Returns null for every message the run loop already handles (`assistant`, `user`,
 * `result`, `stream_event`, `thinking_tokens`) as well as for everything unrecognised, so
 * it is safe to call on every message regardless of where it sits in the loop.
 */
export function interpretSdkMessage(message: unknown): SdkInterpretation | null {
	const msg = asRecord(message)
	if (!msg) return null

	try {
		if (msg.type === 'tool_progress') {
			const toolUseId = str(msg.tool_use_id)
			const elapsed = num(msg.elapsed_time_seconds)
			if (!toolUseId || elapsed === null) return null
			return { kind: 'tool_progress', toolUseId, elapsedSeconds: Math.max(0, Math.round(elapsed)) }
		}

		if (msg.type === 'rate_limit_event') {
			const info = asRecord(msg.rate_limit_info)
			const status = info?.status
			// 'allowed' is the steady state and says nothing; only a warning or a rejection is
			// worth interrupting someone with.
			if (status !== 'allowed_warning' && status !== 'rejected') return null
			const resetsAt = num(info?.resetsAt)
			const when = resetsAt !== null ? new Date(resetsAt * 1000).toLocaleTimeString() : null
			return notice(
				'rate_limit',
				status === 'rejected' ? 'error' : 'warn',
				status === 'rejected' ? 'Rate limited by the API' : 'Approaching the rate limit',
				when ? `Resets around ${when}.` : null,
				status === 'rejected',
			)
		}

		if (msg.type !== 'system') return null
		const subtype = str(msg.subtype)
		if (!subtype) return null
		return systemNotice(subtype, msg)
	} catch {
		// An unexpected shape is not worth a failed turn; the old behaviour was to ignore
		// every one of these anyway.
		return null
	}
}
