import { expect, test } from '@playwright/test'
import {
	AUTOMATION_DISABLE_AFTER_FAILURES,
	AUTOMATION_MAX_ATTEMPTS,
	AUTOMATION_MAX_BACKOFF_MS,
	automationFailureDedupeKey,
	automationRetryDedupeKey,
	computeRetryBackoffMs,
	describeRetryDecision,
	nextRetryAt,
	shouldDisableAfterFailures,
	shouldRetryAutomation,
	toOutputExcerpt,
} from '../src/lib/automations/failure-policy'

/**
 * Issue #31 — the retry / give-up / disable policy for a failed automation tick.
 *
 * Pure-function tests: `src/lib/automations/failure-policy.ts` has no DB, no SvelteKit and
 * no I/O, so this spec runs without Postgres or a dev server (same arrangement as
 * `automations.cron.spec.ts`).
 *
 * What is pinned here:
 *   - a tick is retried a BOUNDED number of times and then stops — the thing that keeps a
 *     broken automation from hammering the queue forever
 *   - the backoff grows and is capped
 *   - the disable threshold counts ticks, and a tick's retries do not inflate it
 *   - the review-item dedupe key is stable across a streak, so a failure loop folds into
 *     one inbox row instead of flooding it
 */

test.describe('automations/failure-policy — retry bound', () => {
	test('retries are bounded by AUTOMATION_MAX_ATTEMPTS', () => {
		expect(AUTOMATION_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2)
		for (let attempt = 1; attempt < AUTOMATION_MAX_ATTEMPTS; attempt += 1) {
			expect(shouldRetryAutomation(attempt), `attempt ${attempt} should retry`).toBe(true)
		}
		expect(shouldRetryAutomation(AUTOMATION_MAX_ATTEMPTS)).toBe(false)
		expect(shouldRetryAutomation(AUTOMATION_MAX_ATTEMPTS + 5)).toBe(false)
	})

	test('a malformed attempt number never opens an unbounded retry loop', () => {
		expect(shouldRetryAutomation(0)).toBe(false)
		expect(shouldRetryAutomation(-3)).toBe(false)
		expect(shouldRetryAutomation(Number.NaN)).toBe(false)
		expect(shouldRetryAutomation(Number.POSITIVE_INFINITY)).toBe(false)
	})

	test('the whole retry chain for one tick fits inside a typical schedule gap', () => {
		let total = 0
		for (let attempt = 1; attempt < AUTOMATION_MAX_ATTEMPTS; attempt += 1) {
			total += computeRetryBackoffMs(attempt)
		}
		// An hourly automation is common; a retry chain must not still be running when the
		// next tick is due, or the two would interleave.
		expect(total).toBeLessThan(60 * 60 * 1000)
	})
})

test.describe('automations/failure-policy — backoff', () => {
	test('backoff grows with each failed attempt and is capped', () => {
		const first = computeRetryBackoffMs(1)
		const second = computeRetryBackoffMs(2)
		expect(first).toBeGreaterThan(0)
		expect(second).toBeGreaterThan(first)
		for (const attempt of [1, 2, 3, 10, 100]) {
			expect(computeRetryBackoffMs(attempt)).toBeLessThanOrEqual(AUTOMATION_MAX_BACKOFF_MS)
		}
	})

	test('backoff is deterministic — the same attempt always waits the same', () => {
		expect(computeRetryBackoffMs(1)).toBe(computeRetryBackoffMs(1))
		expect(computeRetryBackoffMs(2)).toBe(computeRetryBackoffMs(2))
	})

	test('a nonsense attempt falls back to the first backoff rather than 0', () => {
		expect(computeRetryBackoffMs(0)).toBe(computeRetryBackoffMs(1))
		expect(computeRetryBackoffMs(Number.NaN)).toBe(computeRetryBackoffMs(1))
	})

	test('nextRetryAt is the failure instant plus the backoff', () => {
		const now = new Date('2026-09-21T16:00:00.000Z')
		expect(nextRetryAt(1, now).toISOString()).toBe(
			new Date(now.getTime() + computeRetryBackoffMs(1)).toISOString(),
		)
		expect(nextRetryAt(2, now).getTime()).toBeGreaterThan(nextRetryAt(1, now).getTime())
	})
})

test.describe('automations/failure-policy — disable after N', () => {
	test('disables only at the threshold, counting ticks', () => {
		for (let failures = 0; failures < AUTOMATION_DISABLE_AFTER_FAILURES; failures += 1) {
			expect(shouldDisableAfterFailures(failures), `${failures} failures`).toBe(false)
		}
		expect(shouldDisableAfterFailures(AUTOMATION_DISABLE_AFTER_FAILURES)).toBe(true)
		expect(shouldDisableAfterFailures(AUTOMATION_DISABLE_AFTER_FAILURES + 1)).toBe(true)
	})

	test('one tick, even with every retry exhausted, cannot trip the threshold alone', () => {
		// The streak counter is bumped once per tick, not once per attempt. If that ever
		// changes, a single bad morning would switch the automation off.
		expect(AUTOMATION_DISABLE_AFTER_FAILURES).toBeGreaterThan(1)
		expect(shouldDisableAfterFailures(1)).toBe(false)
	})
})

test.describe('automations/failure-policy — dedupe keys', () => {
	test('the review dedupe key is stable within a streak and changes between streaks', () => {
		const id = '11111111-2222-3333-4444-555555555555'
		expect(automationFailureDedupeKey(id, 2)).toBe(automationFailureDedupeKey(id, 2))
		expect(automationFailureDedupeKey(id, 2)).not.toBe(automationFailureDedupeKey(id, 3))
		expect(automationFailureDedupeKey(id, 1)).toContain(id)
	})

	test('the retry dedupe key is derived from the failing job, so redelivery cannot fan out', () => {
		const automationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
		const jobId = '99999999-8888-7777-6666-555555555555'
		expect(automationRetryDedupeKey(jobId, automationId, 2)).toBe(
			automationRetryDedupeKey(jobId, automationId, 2),
		)
		expect(automationRetryDedupeKey(jobId, automationId, 2)).not.toBe(
			automationRetryDedupeKey(jobId, automationId, 3),
		)
		// No job id (manual/edge path) still yields a usable, automation-scoped key.
		expect(automationRetryDedupeKey(null, automationId, 2)).toContain(automationId)
	})
})

test.describe('automations/failure-policy — helpers', () => {
	test('describeRetryDecision says either "retrying" or "giving up", never both', () => {
		const retrying = describeRetryDecision(1)
		expect(retrying).toContain('retrying')
		const giveUp = describeRetryDecision(AUTOMATION_MAX_ATTEMPTS)
		expect(giveUp).toContain('giving up')
		expect(giveUp).not.toContain('retrying')
	})

	test('toOutputExcerpt truncates, trims, and maps empty output to null', () => {
		expect(toOutputExcerpt(null)).toBeNull()
		expect(toOutputExcerpt(undefined)).toBeNull()
		expect(toOutputExcerpt('   ')).toBeNull()
		expect(toOutputExcerpt('  hello  ')).toBe('hello')
		const long = 'x'.repeat(5000)
		const excerpt = toOutputExcerpt(long, 100)
		expect(excerpt).not.toBeNull()
		expect(excerpt!.length).toBe(100)
		expect(excerpt!.endsWith('…')).toBe(true)
		expect(toOutputExcerpt({ a: 1 })).toBe('{"a":1}')
	})
})
