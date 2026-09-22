/**
 * What a completed tool call contributes to the usage ledger.
 *
 * Since #15 the filesystem and shell surface is the SDK's built-ins, and those never touch
 * `executeTool` — so they never reached the one place that wrote ledger rows. `logToolUsage`
 * has two callers in the whole codebase (`handlers/web.server`, `handlers/media.server`),
 * which means the majority of calls in a coding session have been writing nothing at all.
 * `/activity`, the per-agent "most-used tools" list, and anything #38 wants to say about
 * what the agents actually did were all computed over three tools.
 *
 * ## These rows cost nothing, and that is the point
 *
 * A `Read` or an `Edit` runs locally. It spends no money — its cost shows up as tokens,
 * which are already accounted per run. So this records **calls, not spend**, exactly as
 * `web_search` already does for the self-hosted SearXNG backend:
 *
 *   > SearXNG is self-hosted so cost defaults to 0 but the call count is still tracked.
 *
 * Budget enforcement sums `cost`, so a ledger full of zero-cost rows cannot move a limit.
 * That is deliberate: making these rows carry an invented price would corrupt the one
 * number in this system that is allowed to block a run.
 *
 * Pure and dependency-free so a spec can read it without a database.
 */

import type { ToolResultDetails } from '../engine/tool-result-details'

/**
 * Tools that already write their own `call`-unit row, and so must not get a second one.
 *
 * Only `web_search` qualifies. The media handlers log in `credit` / `second` units and only
 * when a generation actually cost money, so a call row alongside them counts the call
 * without double-counting the spend.
 */
export const SELF_LOGGED_CALL_TOOLS: ReadonlySet<string> = new Set(['web_search'])

/** Characters of a command or path kept on the row. Enough to recognise, not to reconstruct. */
export const MAX_LEDGER_LABEL_CHARS = 200

export type ToolCallLedgerEntry = {
	toolName: string
	/** Always 'call' — see the note above on why these rows carry no cost. */
	unitType: 'call'
	units: 1
	cost: 0
	metadata: Record<string, unknown>
}

function clip(value: string): string {
	return value.length > MAX_LEDGER_LABEL_CHARS ? `${value.slice(0, MAX_LEDGER_LABEL_CHARS)}…` : value
}

/**
 * A short, human-readable label for what the call did, taken from the typed result.
 *
 * This is the payoff from keeping `tool_use_result`: the ledger can say *which file* was
 * edited and *which command* ran, rather than just that some `Edit` happened. Null for
 * tools with no distilled shape — a row with no label is still a counted call.
 */
export function ledgerLabel(details: ToolResultDetails | undefined): string | null {
	if (!details) return null
	if (details.kind === 'file_edit') return clip(details.path)
	if (details.kind === 'shell') return details.command ? clip(details.command) : null
	if (details.kind === 'todo') return `${details.completed}/${details.total} done`
	return null
}

/**
 * Build the ledger entry for a completed call, or null when the call must not be logged.
 *
 * Returns null only for the tools that log themselves; everything else is counted,
 * including failures. A tool that failed still consumed a round and still tells you what
 * the agent was trying to do, so leaving failures out would make the busiest sessions look
 * the quietest.
 */
export function toolCallLedgerEntry(input: {
	name: string
	success: boolean
	details?: ToolResultDetails
}): ToolCallLedgerEntry | null {
	if (SELF_LOGGED_CALL_TOOLS.has(input.name)) return null

	const label = ledgerLabel(input.details)
	return {
		toolName: input.name,
		unitType: 'call',
		units: 1,
		cost: 0,
		metadata: {
			success: input.success,
			...(label ? { label } : {}),
		},
	}
}
