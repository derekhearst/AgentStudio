/**
 * #31 — what happens when an automation tick fails.
 *
 * Pure module: no DB, no SvelteKit, no clock of its own. Every decision the failure path
 * makes is a function of (attempt, consecutiveFailures) and lands here so it can be pinned
 * by a unit test that runs without Postgres, and so the numbers live in exactly one place.
 *
 * The shape of the policy:
 *
 *   attempt 1 fails → wait  1 min → attempt 2
 *   attempt 2 fails → wait  5 min → attempt 3
 *   attempt 3 fails → give up on this tick
 *
 * Giving up is what counts as a failure for the disable rule — a tick is one failure no
 * matter how many times we retried it, otherwise a single bad morning would trip the
 * disable threshold on its own. After AUTOMATION_DISABLE_AFTER_FAILURES consecutive failed
 * ticks the automation is switched off with `disabledReason = 'consecutive_failures'`.
 *
 * Retries are deliberately capped well below the tick interval of a typical schedule so a
 * retry chain for one tick cannot still be running when the next tick is due.
 */

/** Attempts per tick, including the first. 3 = the original run plus two retries. */
export const AUTOMATION_MAX_ATTEMPTS = 3

/** Failed *ticks* in a row before the automation is switched off. */
export const AUTOMATION_DISABLE_AFTER_FAILURES = 5

/** Backoff before attempt N+1, indexed by the attempt that just failed (1-based). */
const BACKOFF_SCHEDULE_MS = [60_000, 300_000] as const

/** Ceiling, in case the schedule above is ever extended carelessly. */
export const AUTOMATION_MAX_BACKOFF_MS = 900_000

/**
 * True when a tick whose `attempt`-th try just failed should be retried at all.
 * `attempt` is 1-based; the last allowed attempt returns false.
 */
export function shouldRetryAutomation(attempt: number, maxAttempts = AUTOMATION_MAX_ATTEMPTS): boolean {
	if (!Number.isFinite(attempt) || attempt < 1) return false
	return attempt < maxAttempts
}

/**
 * How long to wait before the retry that follows the failed `attempt` (1-based).
 * Exponential in practice (1m, 5m); the table is explicit so the values are readable
 * rather than derived from a formula nobody re-checks.
 */
export function computeRetryBackoffMs(attempt: number): number {
	if (!Number.isFinite(attempt) || attempt < 1) return BACKOFF_SCHEDULE_MS[0]
	const index = Math.min(Math.floor(attempt), BACKOFF_SCHEDULE_MS.length) - 1
	return Math.min(BACKOFF_SCHEDULE_MS[index] ?? BACKOFF_SCHEDULE_MS[0], AUTOMATION_MAX_BACKOFF_MS)
}

/** The instant a retry of the failed `attempt` should become eligible to run. */
export function nextRetryAt(attempt: number, now: Date): Date {
	return new Date(now.getTime() + computeRetryBackoffMs(attempt))
}

/**
 * True when `consecutiveFailures` (the count INCLUDING the tick that just gave up) means
 * the automation should be switched off.
 */
export function shouldDisableAfterFailures(
	consecutiveFailures: number,
	threshold = AUTOMATION_DISABLE_AFTER_FAILURES,
): boolean {
	if (!Number.isFinite(consecutiveFailures)) return false
	return consecutiveFailures >= threshold
}

/**
 * Dedupe key for the review item a failed tick opens. Scoped to the automation and the
 * failure streak, NOT to the timestamp: while the automation keeps failing the same way,
 * every tick folds into the one open inbox row instead of flooding the queue. A successful
 * run resets `consecutiveFailures`, so the next breakage opens a fresh item.
 */
export function automationFailureDedupeKey(automationId: string, consecutiveFailures: number): string {
	return `automation_failure:${automationId}:${Math.max(1, Math.floor(consecutiveFailures))}`
}

/** Job dedupe key for a retry, derived from the job that failed so it is idempotent. */
export function automationRetryDedupeKey(jobId: string | null, automationId: string, nextAttempt: number): string {
	return `automation_retry:${jobId ?? automationId}:${nextAttempt}`
}

/**
 * Human-readable one-liner for the retry decision — used in logs, the run row's error
 * text, and the review item body so an operator can see the policy without reading code.
 */
export function describeRetryDecision(attempt: number, maxAttempts = AUTOMATION_MAX_ATTEMPTS): string {
	if (shouldRetryAutomation(attempt, maxAttempts)) {
		const waitMinutes = Math.round(computeRetryBackoffMs(attempt) / 60_000)
		return `attempt ${attempt}/${maxAttempts} failed — retrying in ${waitMinutes}m`
	}
	return `attempt ${attempt}/${maxAttempts} failed — giving up on this tick`
}

/** Truncate arbitrary run output to what the ledger stores. */
export function toOutputExcerpt(value: unknown, limit = 2000): string | null {
	if (value === null || value === undefined) return null
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	if (!text) return null
	const trimmed = text.trim()
	if (!trimmed) return null
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}
