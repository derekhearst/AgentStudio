import { expect, test } from '@playwright/test'
import {
	buildFixPrompt,
	checkFailureDedupeKey,
	dedupeChecksByName,
	extractLogExcerpt,
	isWatchWindowOpen,
	isWatchablePullRequestStatus,
	mapCheckRunStatus,
	mapCommitStatusState,
	mapProviderPullRequestState,
	normalizeCheckRun,
	normalizeCommitStatus,
	redactSecrets,
	shouldNotifyFailure,
	summarizeCheckFailure,
	PR_WATCH_LOG_EXCERPT_MAX_CHARS,
	PR_WATCH_MAX_AGE_DAYS,
	type NormalizedCheck,
} from '../src/lib/source-control/pr-checks'

/**
 * Issue #20 — watch CI after the agent opens a pull request, pure half.
 *
 * `src/lib/source-control/pr-checks.ts` has no DB, no network, no SvelteKit and no `node:`
 * imports, so this spec runs without Postgres or a dev server (same arrangement as
 * `monitors.condition.spec.ts`).
 *
 * What is pinned here is the set of rules that stop the watcher becoming a firehose, plus
 * the one rule that stops it becoming a leak:
 *   - a failing check notifies on the pass→fail EDGE, not on every observation
 *   - a check flapping on one commit collapses to one review item; a failure on a NEW
 *     commit is new news
 *   - a re-run that goes green is not shadowed by the failed original
 *   - log excerpts are tails, bounded, and scrubbed of anything token-shaped
 *   - a merged or closed PR stops being watched, and an open one expires after 14 days
 */

const NOW = new Date('2026-09-21T16:00:00Z')

function check(overrides: Partial<NormalizedCheck> = {}): NormalizedCheck {
	return {
		checkName: 'build',
		status: 'failure',
		detailsUrl: null,
		startedAt: null,
		finishedAt: null,
		headSha: 'aaaaaaaaaaaa1111',
		externalId: null,
		conclusion: 'failure',
		outputTitle: null,
		outputSummary: null,
		source: 'check_run',
		...overrides,
	}
}

// ─────────── normalization ───────────

test.describe('pr-checks/normalize — GitHub payloads collapse to one shape', () => {
	test('a check run carries the fields a review item and a log fetch both need', () => {
		const normalized = normalizeCheckRun({
			id: 987654,
			name: 'ci / test',
			status: 'completed',
			conclusion: 'failure',
			head_sha: 'deadbeefcafe',
			details_url: 'https://github.com/o/r/runs/987654',
			started_at: '2026-09-21T15:00:00Z',
			completed_at: '2026-09-21T15:04:00Z',
			output: { title: '3 failing', summary: 'tests failed' },
		})
		expect(normalized).not.toBeNull()
		expect(normalized?.checkName).toBe('ci / test')
		expect(normalized?.status).toBe('failure')
		// The check-run id doubles as the Actions job id — the only route to a log excerpt.
		expect(normalized?.externalId).toBe(987654)
		expect(normalized?.headSha).toBe('deadbeefcafe')
		expect(normalized?.outputTitle).toBe('3 failing')
		expect(normalized?.source).toBe('check_run')
	})

	test('a malformed check run is skipped rather than recorded as an unnamed failure', () => {
		expect(normalizeCheckRun({ status: 'completed', conclusion: 'failure' })).toBeNull()
		expect(normalizeCheckRun(null)).toBeNull()
		expect(normalizeCheckRun('nope')).toBeNull()
	})

	test('a legacy commit status maps onto the same shape via its context + state', () => {
		const normalized = normalizeCommitStatus(
			{
				context: 'continuous-integration/jenkins',
				state: 'error',
				target_url: 'https://jenkins.example/job/42',
				description: 'exploded',
				created_at: '2026-09-21T15:00:00Z',
				updated_at: '2026-09-21T15:05:00Z',
			},
			'deadbeefcafe',
		)
		expect(normalized?.checkName).toBe('continuous-integration/jenkins')
		// `error` and `failure` are both red — GitHub distinguishes them, we do not.
		expect(normalized?.status).toBe('failure')
		expect(normalized?.source).toBe('commit_status')
		expect(normalized?.headSha).toBe('deadbeefcafe')
	})

	test('an unknown commit-status state is pending, never silently green', () => {
		expect(mapCommitStatusState('something_new')).toBe('pending')
		expect(mapCommitStatusState('success')).toBe('success')
		expect(mapCommitStatusState('failure')).toBe('failure')
	})

	test('a mid-flight check run is running or pending, and an unknown conclusion is red', () => {
		expect(mapCheckRunStatus({ status: 'in_progress', conclusion: null })).toBe('running')
		expect(mapCheckRunStatus({ status: 'queued', conclusion: null })).toBe('pending')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'skipped' })).toBe('skipped')
		// Fail loud on a conclusion GitHub adds later rather than reporting a false green.
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'brand_new_thing' })).toBe('failure')
	})
})

// ─────────── dedupe across re-runs and APIs ───────────

test.describe('pr-checks/dedupe — one row per check name', () => {
	test('a re-run that goes green is not shadowed by the failed original', () => {
		const result = dedupeChecksByName([
			check({ status: 'failure', finishedAt: '2026-09-21T15:00:00Z' }),
			check({ status: 'success', conclusion: 'success', finishedAt: '2026-09-21T15:30:00Z' }),
		])
		expect(result).toHaveLength(1)
		expect(result[0].status).toBe('success')
	})

	test('a check reported through both APIs keeps the check_run, which carries the job id', () => {
		const result = dedupeChecksByName([
			normalizeCommitStatus({ context: 'build', state: 'failure' })!,
			check({ checkName: 'build', externalId: 5150 }),
		])
		expect(result).toHaveLength(1)
		expect(result[0].source).toBe('check_run')
		expect(result[0].externalId).toBe(5150)
	})

	test('distinct check names all survive', () => {
		const result = dedupeChecksByName([
			check({ checkName: 'build' }),
			check({ checkName: 'lint' }),
			check({ checkName: 'typecheck' }),
		])
		expect(result.map((c) => c.checkName).sort()).toEqual(['build', 'lint', 'typecheck'])
	})
})

// ─────────── the notification edge ───────────

test.describe('pr-checks/edge — a flapping check does not flood the inbox', () => {
	test('a check we have never seen fail notifies once', () => {
		expect(shouldNotifyFailure({ next: check(), previous: null })).toBe(true)
	})

	test('a pass→fail transition notifies', () => {
		expect(
			shouldNotifyFailure({ next: check(), previous: { status: 'success', headSha: 'aaaaaaaaaaaa1111' } }),
		).toBe(true)
	})

	test('the SAME failure observed again on the same commit stays quiet', () => {
		expect(
			shouldNotifyFailure({ next: check(), previous: { status: 'failure', headSha: 'aaaaaaaaaaaa1111' } }),
		).toBe(false)
	})

	test('red → green → red on one commit produces one further notification, not a stream', () => {
		// The middle observation clears the latch by storing a non-failure status; the
		// re-failure is then a genuine transition. Two edges, two rows — not one per poll.
		const first = shouldNotifyFailure({ next: check(), previous: null })
		const quiet = shouldNotifyFailure({
			next: check({ status: 'success', conclusion: 'success' }),
			previous: { status: 'failure', headSha: 'aaaaaaaaaaaa1111' },
		})
		const second = shouldNotifyFailure({
			next: check(),
			previous: { status: 'success', headSha: 'aaaaaaaaaaaa1111' },
		})
		expect([first, quiet, second]).toEqual([true, false, true])
	})

	test('the same check failing again after a PUSH is new news', () => {
		expect(
			shouldNotifyFailure({
				next: check({ headSha: 'bbbbbbbbbbbb2222' }),
				previous: { status: 'failure', headSha: 'aaaaaaaaaaaa1111' },
			}),
		).toBe(true)
	})

	test('a green, pending or skipped check never notifies', () => {
		for (const status of ['success', 'pending', 'running', 'canceled', 'skipped'] as const) {
			expect(shouldNotifyFailure({ next: check({ status }), previous: null })).toBe(false)
		}
	})

	test('an unknown previous commit errs toward silence rather than a duplicate row', () => {
		// Both red, but we cannot prove it is a different commit. Under-notify: the operator
		// already has an open row for this check.
		expect(shouldNotifyFailure({ next: check({ headSha: null }), previous: { status: 'failure', headSha: null } })).toBe(
			false,
		)
	})
})

test.describe('pr-checks/dedupeKey — commit-scoped review identity', () => {
	const base = { owner: 'o', repo: 'r', prNumber: 7, checkName: 'build' }

	test('the same check on the same commit is one key', () => {
		expect(checkFailureDedupeKey({ ...base, headSha: 'aaaaaaaaaaaa1111' })).toBe(
			checkFailureDedupeKey({ ...base, headSha: 'aaaaaaaaaaaa1111' }),
		)
	})

	test('a different commit, a different check, or a different PR is a different key', () => {
		const key = checkFailureDedupeKey({ ...base, headSha: 'aaaaaaaaaaaa1111' })
		expect(checkFailureDedupeKey({ ...base, headSha: 'bbbbbbbbbbbb2222' })).not.toBe(key)
		expect(checkFailureDedupeKey({ ...base, checkName: 'lint', headSha: 'aaaaaaaaaaaa1111' })).not.toBe(key)
		expect(checkFailureDedupeKey({ ...base, prNumber: 8, headSha: 'aaaaaaaaaaaa1111' })).not.toBe(key)
	})

	test('an unknown SHA degrades to a stable (pr, check) key instead of a random one', () => {
		expect(checkFailureDedupeKey({ ...base, headSha: null })).toBe(checkFailureDedupeKey({ ...base, headSha: null }))
		expect(checkFailureDedupeKey({ ...base, headSha: null })).toContain('unknown-sha')
	})
})

// ─────────── log excerpts ───────────

test.describe('pr-checks/logs — bounded, tailed and scrubbed', () => {
	test('the excerpt is the TAIL, because that is where the failure is', () => {
		const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
		const excerpt = extractLogExcerpt(log, { maxLines: 5 })
		expect(excerpt).toContain('line 499')
		expect(excerpt).not.toContain('line 100')
	})

	test('Actions timestamp prefixes and blank lines come off', () => {
		const log = ['2026-09-21T15:00:00.1234567Z npm ERR! boom', '', '2026-09-21T15:00:01.0000000Z exit 1'].join('\n')
		expect(extractLogExcerpt(log)).toBe('npm ERR! boom\nexit 1')
	})

	test('a huge excerpt is clamped from the FRONT so the failing lines survive', () => {
		const log = `${'x'.repeat(50_000)}\nFINAL FAILURE LINE`
		const excerpt = extractLogExcerpt(log)
		expect(excerpt.length).toBeLessThanOrEqual(PR_WATCH_LOG_EXCERPT_MAX_CHARS + 2)
		expect(excerpt).toContain('FINAL FAILURE LINE')
	})

	test('anything token-shaped is redacted before it can reach a review item', () => {
		const raw = [
			'export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz',
			'api_key=supersecretvalue123',
			'git clone https://x-access-token:ghs_zzzzzzzzzzzzzzzzzzzz@github.com/o/r',
		].join('\n')
		const redacted = redactSecrets(raw)
		expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
		expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
		expect(redacted).not.toContain('supersecretvalue123')
		expect(redacted).not.toContain('ghs_zzzzzzzzzzzzzzzzzzzz')
	})

	test('ordinary log text is left alone', () => {
		const raw = 'FAIL src/lib/thing.spec.ts\n  ● expected 3 to be 4'
		expect(redactSecrets(raw)).toBe(raw)
	})
})

// ─────────── watch lifecycle ───────────

test.describe('pr-checks/lifecycle — the watch stops', () => {
	test('a merged or closed PR is not watchable; an open or draft one is', () => {
		expect(isWatchablePullRequestStatus('open')).toBe(true)
		expect(isWatchablePullRequestStatus('draft')).toBe(true)
		expect(isWatchablePullRequestStatus('merged')).toBe(false)
		expect(isWatchablePullRequestStatus('closed')).toBe(false)
	})

	test('GitHub reports a merge as closed+merged, and we record the merge', () => {
		expect(mapProviderPullRequestState({ state: 'closed', merged: true, draft: false })).toBe('merged')
		expect(mapProviderPullRequestState({ state: 'closed', merged: false, draft: false })).toBe('closed')
		expect(mapProviderPullRequestState({ state: 'open', merged: false, draft: true })).toBe('draft')
		expect(mapProviderPullRequestState({ state: 'open', merged: false, draft: false })).toBe('open')
	})

	test('an abandoned PR falls out of the watch window instead of polling forever', () => {
		const fresh = new Date(NOW.getTime() - 60 * 60 * 1_000)
		const stale = new Date(NOW.getTime() - (PR_WATCH_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1_000)
		expect(isWatchWindowOpen(fresh, NOW)).toBe(true)
		expect(isWatchWindowOpen(stale, NOW)).toBe(false)
	})

	test('an unparseable creation date closes the window rather than opening it forever', () => {
		expect(isWatchWindowOpen('not a date', NOW)).toBe(false)
	})
})

// ─────────── presentation ───────────

test.describe('pr-checks/presentation — what the operator and the agent read', () => {
	test('the review summary names the check, the repo and the PR', () => {
		const summary = summarizeCheckFailure({
			owner: 'derekhearst',
			repo: 'AgentStudio',
			prNumber: 42,
			checkName: 'ci / test',
			title: '3 failing',
		})
		expect(summary).toContain('ci / test')
		expect(summary).toContain('derekhearst/AgentStudio#42')
		expect(summary.length).toBeLessThanOrEqual(500)
	})

	test('the seeded fix prompt carries the failure and tells the agent not to chase flakes', () => {
		const prompt = buildFixPrompt({
			owner: 'o',
			repo: 'r',
			prNumber: 42,
			checkName: 'ci / test',
			prTitle: 'Add the thing',
			headBranch: 'feat/thing',
			prUrl: 'https://github.com/o/r/pull/42',
			logExcerpt: 'expected 3 to be 4',
			headSha: 'aaaaaaaaaaaa1111',
		})
		expect(prompt).toContain('o/r#42')
		expect(prompt).toContain('ci / test')
		expect(prompt).toContain('feat/thing')
		expect(prompt).toContain('expected 3 to be 4')
		// The guard that stops the most common wrong move: rewriting working code to make
		// an unrelated red check go away.
		expect(prompt).toContain('Diagnose the failure first')
		expect(prompt.toLowerCase()).toContain('unrelated to this branch')
	})

	test('a seeded prompt never carries a credential out of a log', () => {
		const prompt = buildFixPrompt({
			owner: 'o',
			repo: 'r',
			prNumber: 1,
			checkName: 'build',
			prTitle: 't',
			headBranch: 'b',
			summary: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed',
		})
		expect(prompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
	})
})
