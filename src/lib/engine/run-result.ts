/**
 * Reading the SDK's `result` message: what the turn cost, and why it failed.
 *
 * Three fields on it are easy to read wrongly, and the engine read all three wrongly.
 *
 * - `usage` counts the MAIN AGENT LOOP only. A `Task` subagent's model calls, and the calls
 *   the CLI makes to compact the context, are not in it, so a turn that delegated its heavy
 *   lifting was recorded as the parent's few thousand tokens. `modelUsage` is the SDK's field
 *   for accounting: every model call made for the `query()`, per model.
 * - `modelUsage` and `total_cost_usd` are running totals for the SESSION, not for the turn.
 *   A resumed session starts from the totals its transcript saved, so the first result of a
 *   resumed turn already carries every earlier turn. Every chat turn after the first
 *   resumes, so a figure logged as reported counts turn one again on turn two, turns one and
 *   two again on turn three, and so on — and budget limits sum those rows.
 * - `result` exists on the `success` subtype only. The error subtypes (`error_max_turns`,
 *   `error_during_execution`, …) carry their reason in `errors[]`, so reading `result` turned
 *   every failure into "Run failed".
 *
 * So a turn's usage is its session's running total minus the running total the previous
 * turn reported. The caller keeps that previous total with the assistant message
 * (`metadata.sessionUsage`) and hands it back as the baseline.
 *
 * Pure, with no imports, so a spec can load it without SvelteKit or a database.
 */

export type TokenCounts = {
	inputTokens: number
	outputTokens: number
	cacheCreationTokens: number
	cacheReadTokens: number
}

/**
 * One turn's usage, which is what gets logged against the run.
 *
 * `costUsd` is the SDK's own estimate. Meaningless for subscription runs, which is why Claude
 * runs are accounted in tokens rather than dollars. `null` means this turn's share cannot be
 * told apart from the session's — a resumed session with no stored baseline — and the caller
 * should price the tokens itself rather than log a figure that includes earlier turns.
 */
export type EngineUsage = TokenCounts & { costUsd: number | null }

/** A session's running totals as of one result: what the next turn subtracts. */
export type SessionUsage = TokenCounts & { sessionId: string; costUsd: number }

/**
 * Whether a turn's usage already counts its delegated children (#32).
 *
 * A figure read from `modelUsage` covers every model call the query made, children
 * included; a fallback to `usage` covers the main loop alone. The two halves can differ: the
 * one producer with no `modelUsage` still reports `total_cost_usd`, which includes children,
 * next to main-loop tokens that do not. A child's own ledger row is carved out of the parent's
 * figure where the figure includes it, and added beside it where it does not — so nothing is
 * counted twice and nothing is lost.
 */
export type UsageCoverage = { tokens: boolean; cost: boolean }

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'] as const

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/** The main loop's own counts. Per turn, but blind to subagents and compaction. */
export function mainLoopTokens(result: Record<string, unknown>): TokenCounts {
	const usage = (result.usage ?? {}) as Record<string, unknown>
	return {
		inputTokens: count(usage.input_tokens),
		outputTokens: count(usage.output_tokens),
		cacheCreationTokens: count(usage.cache_creation_input_tokens),
		cacheReadTokens: count(usage.cache_read_input_tokens),
	}
}

/**
 * The session's running totals as of this result, summed across models.
 *
 * Null when the result names no session or carries no `modelUsage` at all — a producer that
 * does not report running totals, whose `usage` is then the only figure there is.
 */
export function sessionUsageFromResult(result: Record<string, unknown>): SessionUsage | null {
	const sessionId = typeof result.session_id === 'string' && result.session_id.length > 0 ? result.session_id : null
	const perModel = result.modelUsage
	if (!sessionId || !perModel || typeof perModel !== 'object') return null

	const totals: SessionUsage = {
		sessionId,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		costUsd: 0,
	}
	let modelCost = 0
	for (const entry of Object.values(perModel as Record<string, Record<string, unknown>>)) {
		if (!entry || typeof entry !== 'object') continue
		totals.inputTokens += count(entry.inputTokens)
		totals.outputTokens += count(entry.outputTokens)
		totals.cacheCreationTokens += count(entry.cacheCreationInputTokens)
		totals.cacheReadTokens += count(entry.cacheReadInputTokens)
		modelCost += count(entry.costUSD)
	}
	// `total_cost_usd` covers the same calls as `modelUsage`; the per-model sum is the fallback.
	totals.costUsd = typeof result.total_cost_usd === 'number' ? count(result.total_cost_usd) : modelCost
	return totals
}

/**
 * Whether `later` can be a continuation of `earlier`. A running total only grows, so any
 * figure that went down means the total restarted — the transcript had none saved, or the
 * session was cleared — and the later figure is this turn's alone.
 */
function continues(later: SessionUsage, earlier: SessionUsage): boolean {
	return later.costUsd >= earlier.costUsd && TOKEN_FIELDS.every((field) => later[field] >= earlier[field])
}

/**
 * This turn's usage, and the session's running totals to keep for the next turn.
 *
 * `resumed` is whether the run asked the SDK to resume a session. `baseline` is the running
 * total the previous turn of that session reported; it only counts when the result is for
 * the same session.
 */
export function readTurnUsage(
	result: Record<string, unknown>,
	context: { resumed: boolean; baseline: SessionUsage | null },
): { usage: EngineUsage; session: SessionUsage | null; includesSubagents: UsageCoverage } {
	const mainLoop = mainLoopTokens(result)
	const session = sessionUsageFromResult(result)
	/** Every model call of the turn, children included — the `modelUsage` paths. */
	const whole: UsageCoverage = { tokens: true, cost: true }
	/** The main loop's own counts, and a price left to the caller. */
	const mainLoopOnly: UsageCoverage = { tokens: false, cost: false }

	if (!session) {
		const cost = typeof result.total_cost_usd === 'number' ? count(result.total_cost_usd) : 0
		return {
			usage: { ...mainLoop, costUsd: context.resumed ? null : cost },
			session: null,
			// `total_cost_usd` covers the children; main-loop tokens do not.
			includesSubagents: { tokens: false, cost: !context.resumed },
		}
	}

	const totals: EngineUsage = {
		inputTokens: session.inputTokens,
		outputTokens: session.outputTokens,
		cacheCreationTokens: session.cacheCreationTokens,
		cacheReadTokens: session.cacheReadTokens,
		costUsd: session.costUsd,
	}
	const baseline = context.baseline?.sessionId === session.sessionId ? context.baseline : null

	if (baseline) {
		if (!continues(session, baseline)) return { usage: totals, session, includesSubagents: whole }
		return {
			usage: {
				inputTokens: session.inputTokens - baseline.inputTokens,
				outputTokens: session.outputTokens - baseline.outputTokens,
				cacheCreationTokens: session.cacheCreationTokens - baseline.cacheCreationTokens,
				cacheReadTokens: session.cacheReadTokens - baseline.cacheReadTokens,
				// Floating-point subtraction of two dollar figures; keep it from reading -0.000…1.
				costUsd: Math.max(0, session.costUsd - baseline.costUsd),
			},
			session,
			includesSubagents: whole,
		}
	}

	/*
	 * A resumed session with nothing to subtract: a conversation whose earlier turns predate
	 * this bookkeeping, or a session the SDK forked. Its running totals include turns already
	 * logged, so the honest figure is the main loop's own — an undercount of any delegated
	 * work this one time, rather than every earlier turn counted again.
	 */
	if (context.resumed) return { usage: { ...mainLoop, costUsd: null }, session, includesSubagents: mainLoopOnly }

	// A fresh session: its running total is this turn.
	return { usage: totals, session, includesSubagents: whole }
}

/** Parse a stored `sessionUsage`, or null when it is missing or not the right shape. */
export function parseSessionUsage(value: unknown): SessionUsage | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) return null
	const numbers = [...TOKEN_FIELDS, 'costUsd'] as const
	if (!numbers.every((field) => typeof v[field] === 'number' && Number.isFinite(v[field]))) return null
	return {
		sessionId: v.sessionId,
		inputTokens: v.inputTokens as number,
		outputTokens: v.outputTokens as number,
		cacheCreationTokens: v.cacheCreationTokens as number,
		cacheReadTokens: v.cacheReadTokens as number,
		costUsd: v.costUsd as number,
	}
}

/** What each error subtype means, for a result that carries no text of its own. */
const ERROR_SUBTYPE_REASONS: Record<string, string> = {
	error_max_turns: 'Stopped after reaching the maximum number of turns.',
	error_max_budget_usd: 'Stopped after reaching the spending limit for this run.',
	error_during_execution: 'The run failed while it was executing.',
	error_max_structured_output_retries: 'Could not produce a valid structured response.',
}

/**
 * Why a turn failed, or null when it did not.
 *
 * Failure is still `is_error`, exactly as before — only the message changed. The SDK's own
 * text comes first (`errors[]` on the error subtypes, `result` on a success-subtype API
 * error), then what the subtype means, and only then the old generic "Run failed".
 */
export function resultErrorMessage(result: Record<string, unknown>): string | null {
	if (!result.is_error) return null

	const errors = Array.isArray(result.errors)
		? result.errors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim())
		: []
	if (errors.length > 0) return errors.join('\n')

	if (typeof result.result === 'string' && result.result.trim().length > 0) return result.result.trim()

	const subtype = typeof result.subtype === 'string' ? result.subtype : ''
	return ERROR_SUBTYPE_REASONS[subtype] ?? 'Run failed'
}
