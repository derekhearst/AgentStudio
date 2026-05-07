import { logger } from '$lib/observability/logger'

/**
 * Pure tool-output trimming + offload helpers. No node:* / SvelteKit imports — the offload sink
 * is supplied as a callback so unit tests can verify the truncation shape without touching disk.
 *
 * Strategy when an output exceeds `limit`:
 *   1. Slice off `headChars` from the start and `tailChars` from the end.
 *   2. Drop the middle, replace with an elision marker that includes the original full size and
 *      a handle pointing to the offloaded copy (e.g. `.tool-outputs/<callId>.txt`).
 *   3. Call `offload(content)` so the wrapper can persist the full payload to the workspace,
 *      run-event log, or any other durable surface.
 *
 * The model sees enough of the head and tail to keep reasoning, plus a clear pointer to recover
 * the full content via `file_read` (sandbox group) when it actually needs the middle.
 */

export type OffloadHandle = string

export type TrimWithOffloadInput = {
	/** The tool name — used to look up per-tool size limits. */
	toolName: string
	/** The full serialized result content (already JSON-stringified if structured). */
	content: string
	/** Stable identifier for the tool call — used to construct the offload handle. */
	callId: string
	/** Sink that persists the full content; receives the relative handle path. */
	offload?: (handle: OffloadHandle, fullContent: string) => Promise<void> | void
}

export type TrimWithOffloadResult = {
	/** What the model sees — either the original content (small) or head + elision + tail. */
	visible: string
	/** True iff the content was offloaded. */
	offloaded: boolean
	/** The handle written into the elision marker (also passed to the offload callback). */
	handle: OffloadHandle | null
	/** Original size, in chars. */
	fullSize: number
	/** What the truncated visible string takes up, in chars. */
	visibleSize: number
}

const DEFAULT_LIMITS: Record<string, number> = {
	web_search: 6000,
	file_read: 32000,
	shell: 16000,
	browser_screenshot: Infinity,
	run_subagent: 16000,
	git_diff: 16000,
	git_log: 8000,
}

const FALLBACK_LIMIT = 16000

/**
 * Per-tool head/tail split: how much of the visible budget goes to the head vs tail. Defaults to
 * 60/40 because the head usually carries the structural context (command echo, file path,
 * column headers) and the tail tends to carry the "what just happened" (errors, summary lines).
 */
function headTailRatio(toolName: string): { headFrac: number; tailFrac: number } {
	if (toolName === 'shell') return { headFrac: 0.4, tailFrac: 0.6 } // shell stderr is usually at the end
	if (toolName === 'git_log') return { headFrac: 0.85, tailFrac: 0.15 } // newest commits first
	return { headFrac: 0.6, tailFrac: 0.4 }
}

export function getToolOutputLimit(toolName: string): number {
	return DEFAULT_LIMITS[toolName] ?? FALLBACK_LIMIT
}

/**
 * Trim a tool output to the per-tool budget. When the content fits, returns it verbatim with no
 * offload. When it exceeds the budget, splits into head+tail with an elision marker referencing
 * the offload handle, AND fires the offload callback so the wrapper can persist the full payload.
 *
 * web_search gets a special path that trims each result's snippet/content rather than chopping
 * the array — the result count usually matters, the per-result body length usually doesn't.
 */
export async function trimWithOffload(input: TrimWithOffloadInput): Promise<TrimWithOffloadResult> {
	const limit = getToolOutputLimit(input.toolName)
	const fullSize = input.content.length

	if (fullSize <= limit || limit === Infinity) {
		return { visible: input.content, offloaded: false, handle: null, fullSize, visibleSize: fullSize }
	}

	// web_search: trim each result's verbose fields, keep the array shape so result-count semantics survive.
	if (input.toolName === 'web_search') {
		try {
			const parsed = JSON.parse(input.content)
			if (Array.isArray(parsed)) {
				const trimmed = parsed.slice(0, 5).map((r: Record<string, unknown>) => ({
					...r,
					snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 500) : r.snippet,
					content: typeof r.content === 'string' ? r.content.slice(0, 500) : r.content,
				}))
				const out = JSON.stringify(trimmed)
				if (out.length <= limit) {
					return { visible: out, offloaded: false, handle: null, fullSize, visibleSize: out.length }
				}
				// Fell through — the trimmed array still exceeds the budget. Drop into the
				// generic head/tail path below.
			}
		} catch {
			// Not JSON — same generic path.
		}
	}

	const handle = `.tool-outputs/${input.callId}.txt`
	const elision = `\n\n[output offloaded; full size: ${fullSize} chars. To read the full payload, call file_read('${handle}') after enabling the sandbox capability.]\n\n`

	const budget = Math.max(0, limit - elision.length)
	const { headFrac, tailFrac } = headTailRatio(input.toolName)
	const headChars = Math.floor(budget * headFrac)
	const tailChars = Math.max(0, budget - headChars)

	const head = input.content.slice(0, headChars)
	const tail = tailChars > 0 ? input.content.slice(-tailChars) : ''
	const visible = head + elision + tail

	if (input.offload) {
		try {
			await input.offload(handle, input.content)
		} catch (err) {
			// Best-effort: if the sink fails, the model still gets head+tail (just no recoverable handle).
			logger.warn('[output-offload] sink failed; visible tail+head still returned', { err })
		}
	}

	return { visible, offloaded: true, handle, fullSize, visibleSize: visible.length }
}
