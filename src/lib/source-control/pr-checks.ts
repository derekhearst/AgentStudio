import type { PullRequestCheckStatus, PullRequestStatus } from './source-control.schema'

/**
 * #20 — the pure half of "watch CI after the agent opens a pull request".
 *
 * Everything here is decision-making with no database, no network and no SvelteKit: the
 * poller (`pr-watch.server.ts`) and the webhook route both funnel their raw GitHub payloads
 * through these functions so the two triggers can never disagree about what a check means.
 * That symmetry is the whole point — a webhook delivery and a poll of the same commit must
 * produce the same `pull_request_checks` row and the same decision about whether to shout.
 *
 * The rules that keep this from becoming a firehose, in the order they bite:
 *
 *   1. Edge-triggered notification. `shouldNotifyFailure` fires on the pass→fail transition
 *      for a given commit, not on every observation of a failing check. This is the same
 *      latch discipline #33's monitors use; it is reimplemented per (check, commit) here
 *      because a PR has N checks and a monitor has one boolean.
 *   2. Commit-scoped dedupe. `checkFailureDedupeKey` includes the head SHA, so a check that
 *      flaps red→green→red on ONE commit collapses to a single review item, while a genuine
 *      new failure after a push gets its own row.
 *   3. A bounded watch window. `isWatchWindowOpen` stops polling a PR that has sat open for
 *      longer than `PR_WATCH_MAX_AGE_DAYS`, so an abandoned PR is not a standing API bill.
 *      (A merged or closed PR stops immediately — see `isWatchablePullRequestStatus`.)
 *   4. Bounded log excerpts. Logs are tailed, de-timestamped, redacted and truncated before
 *      they are ever written to a review item.
 */

// ─────────── Caps ───────────

/** How long a PR stays watched while it remains open. An abandoned PR stops being news. */
export const PR_WATCH_MAX_AGE_DAYS = 14
/** Dispatch tick cadence. Checks take minutes, so a sub-minute poll buys nothing. */
export const PR_WATCH_DISPATCH_INTERVAL_MS = 3 * 60 * 1_000
/** Fan-out ceiling per tick; a backlog drains oldest-first over successive ticks. */
export const PR_WATCH_MAX_PRS_PER_TICK = 40
/** Log excerpt bounds — a review item carries a hint, not a build log. */
export const PR_WATCH_LOG_EXCERPT_MAX_LINES = 60
export const PR_WATCH_LOG_EXCERPT_MAX_CHARS = 4_000
/** Log downloads are the expensive call, so only the first few failures of a poll get one. */
export const PR_WATCH_MAX_LOG_FETCHES_PER_POLL = 3

export const PR_WATCH_MAX_AGE_MS = PR_WATCH_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000

// ─────────── Normalized check shape ───────────

/**
 * One check, flattened from whichever GitHub surface produced it. The modern Checks API
 * (`check_runs`) and the legacy commit-status API (`statuses`) describe the same idea with
 * different field names; both land here so the rest of the domain only knows one shape.
 */
export type NormalizedCheck = {
	/** Unique per PR — this is the `pull_request_checks.check_name` natural key. */
	checkName: string
	status: PullRequestCheckStatus
	detailsUrl: string | null
	startedAt: string | null
	finishedAt: string | null
	/** The commit this check ran against. Part of the failure identity. */
	headSha: string | null
	/** check_run id. For GitHub Actions this doubles as the job id used to fetch logs. */
	externalId: number | null
	conclusion: string | null
	outputTitle: string | null
	outputSummary: string | null
	source: 'check_run' | 'commit_status'
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Map a check run's status + conclusion to our check enum. Mid-flight checks have
 * `conclusion=null`; we fall back to GitHub's `status`.
 *
 * Lives here rather than in `github-webhook.ts` (which re-exports it) because both the
 * webhook and the poller need it and this module is the one with no `node:` imports —
 * that keeps the pure spec runnable without a server.
 */
export function mapCheckRunStatus(input: {
	status: 'queued' | 'in_progress' | 'completed' | string
	conclusion: string | null
}): PullRequestCheckStatus {
	if (input.status !== 'completed') {
		if (input.status === 'in_progress') return 'running'
		return 'pending' // queued + anything else GitHub adds defaults to pending
	}
	switch (input.conclusion) {
		case 'success':
		case 'neutral':
			return 'success'
		case 'failure':
		case 'timed_out':
		case 'action_required':
		case 'stale':
			return 'failure'
		case 'cancelled':
			return 'canceled'
		case 'skipped':
			return 'skipped'
		default:
			return 'failure'
	}
}

/** Flatten one entry of `GET /repos/{o}/{r}/commits/{ref}/check-runs`. */
export function normalizeCheckRun(raw: unknown, fallbackSha: string | null = null): NormalizedCheck | null {
	if (!raw || typeof raw !== 'object') return null
	const run = raw as Record<string, unknown>
	const checkName = asString(run.name)
	const ghStatus = asString(run.status)
	if (!checkName || !ghStatus) return null

	const conclusion = asString(run.conclusion)
	const output = (run.output as Record<string, unknown> | undefined) ?? {}
	return {
		checkName,
		status: mapCheckRunStatus({ status: ghStatus, conclusion }),
		detailsUrl: asString(run.details_url) ?? asString(run.html_url),
		startedAt: asString(run.started_at),
		finishedAt: asString(run.completed_at),
		headSha: asString(run.head_sha) ?? fallbackSha,
		externalId: typeof run.id === 'number' ? run.id : null,
		conclusion,
		outputTitle: asString(output.title),
		// `output.text` is the long form; `summary` is the one-screen version and is what a
		// review item wants. The text body, when present, is folded in by the caller as part
		// of the log excerpt instead.
		outputSummary: asString(output.summary) ?? asString(output.text),
		source: 'check_run',
	}
}

/**
 * Map a legacy commit-status `state` onto our check enum. `error` and `failure` are both
 * red — GitHub distinguishes "the build failed" from "the reporter blew up", we do not.
 */
export function mapCommitStatusState(state: string): PullRequestCheckStatus {
	switch (state) {
		case 'success':
			return 'success'
		case 'pending':
			return 'pending'
		case 'failure':
		case 'error':
			return 'failure'
		default:
			// An unrecognized state is not silently green. Pending keeps it out of the
			// failure path while remaining visibly unfinished.
			return 'pending'
	}
}

/** Flatten one entry of `GET /repos/{o}/{r}/commits/{ref}/status`'s `statuses` array. */
export function normalizeCommitStatus(raw: unknown, fallbackSha: string | null = null): NormalizedCheck | null {
	if (!raw || typeof raw !== 'object') return null
	const status = raw as Record<string, unknown>
	const context = asString(status.context)
	const state = asString(status.state)
	if (!context || !state) return null

	const mapped = mapCommitStatusState(state)
	return {
		checkName: context,
		status: mapped,
		detailsUrl: asString(status.target_url),
		startedAt: asString(status.created_at),
		finishedAt: mapped === 'pending' ? null : asString(status.updated_at),
		headSha: fallbackSha,
		externalId: null,
		conclusion: state,
		outputTitle: null,
		outputSummary: asString(status.description),
		source: 'commit_status',
	}
}

/**
 * Collapse a list of checks onto one row per name, which is what `pull_request_checks`
 * stores. Two things produce duplicates:
 *
 *   - a re-run: the Checks API returns every attempt, oldest first. The newest attempt is
 *     the truth, so a re-run that goes green must not be shadowed by the failed original.
 *   - the same job reported through both APIs: a check_run wins over a commit status,
 *     because it carries the id we need to fetch logs with.
 *
 * "Newest" is decided by finished time, then start time, then position in the response —
 * GitHub's ordering is the last resort, not the first.
 */
export function dedupeChecksByName(checks: NormalizedCheck[]): NormalizedCheck[] {
	const byName = new Map<string, { check: NormalizedCheck; index: number }>()
	checks.forEach((check, index) => {
		const existing = byName.get(check.checkName)
		if (!existing || isNewerCheck(check, index, existing.check, existing.index)) {
			byName.set(check.checkName, { check, index })
		}
	})
	return [...byName.values()].map((entry) => entry.check)
}

function isNewerCheck(a: NormalizedCheck, aIndex: number, b: NormalizedCheck, bIndex: number): boolean {
	if (a.source !== b.source) return a.source === 'check_run'
	const aTime = timeOf(a)
	const bTime = timeOf(b)
	if (aTime !== bTime) return aTime > bTime
	return aIndex > bIndex
}

function timeOf(check: NormalizedCheck): number {
	const stamp = check.finishedAt ?? check.startedAt
	if (!stamp) return 0
	const parsed = Date.parse(stamp)
	return Number.isNaN(parsed) ? 0 : parsed
}

// ─────────── The notification edge ───────────

/** What we already had on file for this check, as read from `pull_request_checks`. */
export type PreviousCheckState = {
	status: PullRequestCheckStatus
	/** The commit the stored row was recorded against, if we know it. */
	headSha: string | null
} | null

/**
 * Should this observation open a review item?
 *
 * Yes exactly when the check is red AND we have not already shouted about it being red on
 * this commit. Three cases produce a "yes":
 *
 *   - we have never seen this check before (first poll after CI turned red)
 *   - the stored row was not red (a pass→fail transition, the interesting one)
 *   - the stored row was red but on a DIFFERENT commit (the author pushed a fix and it
 *     failed again — genuinely new news, and the dedupe key differs accordingly)
 *
 * Everything else is the same failure observed again, which is what floods an inbox.
 */
export function shouldNotifyFailure(input: { next: NormalizedCheck; previous: PreviousCheckState }): boolean {
	if (input.next.status !== 'failure') return false
	const { previous, next } = input
	if (!previous) return true
	if (previous.status !== 'failure') return true
	// Both red. Only news if it is a different commit — and only when we can actually tell.
	if (!previous.headSha || !next.headSha) return false
	return previous.headSha !== next.headSha
}

/**
 * Identity of one failure for review-inbox dedupe. Commit-scoped on purpose: a flapping
 * check on one commit is one row, a failure on a new commit is a new row. When the SHA is
 * unknown the key degrades to (pr, check), which errs toward under-notifying.
 */
export function checkFailureDedupeKey(input: {
	owner: string
	repo: string
	prNumber: number
	checkName: string
	headSha: string | null
}): string {
	const sha = input.headSha ? input.headSha.slice(0, 12) : 'unknown-sha'
	return `pr_check_failed:${input.owner}/${input.repo}:${input.prNumber}:${sha}:${input.checkName}`
}

// ─────────── Log excerpts ───────────

/**
 * Strip anything that looks like a credential before it can reach a review item, a
 * notification body or a seeded prompt.
 *
 * GitHub masks its own secrets in Actions logs, but "GitHub masks it" is not a property we
 * control, and a failing build is exactly the situation where someone has just echoed an
 * environment variable to debug it. This runs over every excerpt unconditionally.
 */
export function redactSecrets(text: string): string {
	return (
		text
			// Provider tokens by their published prefixes.
			.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted-token]')
			.replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-token]')
			// AWS access key IDs. A CI runner commonly carries these even when the
			// application never touches AWS, and the format is distinctive enough that
			// matching it cannot swallow ordinary build output.
			.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]')
			.replace(/\b(bearer|token|authorization)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
			// Credentials embedded in a URL: `scheme://user:password@host`.
			//
			// This is the one that matters most for THIS code path. A connection string is
			// the classic way a live credential ends up in plain text, and a failing
			// migration or test-setup step echoing `DATABASE_URL` is precisely the kind of
			// build failure whose log tail we harvest. Matching any `\w+://` rather than
			// enumerating schemes forever means a scheme nobody thought of (clickhouse://,
			// kafka://, a vendor's own) is covered on the day it shows up.
			//
			// Only the password component goes: the scheme, the user and the host survive,
			// so the line stays diagnosable — "cannot connect to postgres as derek at
			// 192.168.0.2" is the actual information in that log line, and destroying it
			// would make the excerpt useless for the thing it exists to explain.
			.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s:/@]+):([^\s/@]+)@/gi, '$1://$2:[redacted]@')
			// Belt and braces for a token pasted without a scheme in front of it.
			.replace(/\bx-access-token:[^@\s]+@/gi, 'x-access-token:[redacted]@')
			// Generic `SOMETHING_SECRET=value`. Runs LAST, and deliberately so: it is the
			// broadest rule, and when it ran first it ate the tail of any URL whose user
			// component happened to contain "token" — `x-access-token:…@github.com/o/r`
			// collapsed to `x-access-token=[redacted]`, losing the host and with it the
			// only diagnosable part of the line. Letting the structural URL rule go first
			// keeps `scheme://user:[redacted]@host` intact.
			//
			// The value charset excludes `@` for the same reason, and the lookahead stops
			// the rule re-matching text an earlier rule already redacted — which is what
			// makes the whole function idempotent, and therefore safe to apply more than
			// once on the way to the inbox.
			.replace(
				/\b([A-Za-z0-9_]*(?:secret|token|password|api[_-]?key)[A-Za-z0-9_]*)\s*[:=]\s*("?(?!\[redacted)[^\s"'@]{8,}"?)/gi,
				'$1=[redacted]',
			)
	)
}

/**
 * Turn a raw job log into something a human can read in an inbox row.
 *
 * Takes the TAIL, because a build log's last lines are the ones that explain why it died;
 * the first lines are dependency installation. Actions prefixes every line with an ISO
 * timestamp, which is pure noise at this width, so it comes off. Then redact, then clamp.
 */
export function extractLogExcerpt(
	raw: string,
	options: { maxLines?: number; maxChars?: number } = {},
): string {
	const maxLines = options.maxLines ?? PR_WATCH_LOG_EXCERPT_MAX_LINES
	const maxChars = options.maxChars ?? PR_WATCH_LOG_EXCERPT_MAX_CHARS

	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?/, '').trimEnd())
		.filter((line) => line.trim().length > 0)

	const tail = lines.slice(-maxLines).join('\n')
	const redacted = redactSecrets(tail)
	if (redacted.length <= maxChars) return redacted
	// Clamp from the front so the final lines — the actual failure — survive.
	return `…\n${redacted.slice(-maxChars)}`
}

// ─────────── Presentation ───────────

/**
 * The one-line headline on the review item.
 *
 * `title` is `check_run.output.title` — CI-authored free text, which means it is on the
 * same footing as a log tail and gets the same scrub. A check that titles itself with the
 * command it just failed to run ("psql postgres://u:pw@host failed") would otherwise put a
 * live credential in the inbox headline, where it is MORE visible than in the excerpt.
 */
export function summarizeCheckFailure(input: {
	owner: string
	repo: string
	prNumber: number
	checkName: string
	title?: string | null
}): string {
	const suffix = input.title ? ` — ${redactSecrets(input.title)}` : ''
	return `CI failed: ${input.checkName} on ${input.owner}/${input.repo}#${input.prNumber}${suffix}`.slice(0, 500)
}

/**
 * The message seeded into the originating conversation when the operator presses "Fix it".
 *
 * Written as an instruction to an agent that has lost its context: the conversation it
 * lands in may be hours old and the model has no memory of having opened the PR. It states
 * the facts, then asks for a diagnosis before a change, because the most common wrong move
 * here is to "fix" a flake by rewriting working code.
 *
 * It asks for the change as a patch, not an edit, because the run cannot make one (see
 * `CI_FIX_POLICY`). A prompt that said "fix it and report what you changed" to a run with
 * no way to change anything invited a report of edits that never happened.
 *
 * Every CI-authored field it embeds is re-scrubbed here even though its callers already
 * store scrubbed values. Redaction is idempotent, so the duplicate pass costs nothing, and
 * this way the guarantee is a property of the function rather than of remembering to call
 * it correctly — a future caller that reads a raw summary straight off a payload cannot
 * turn a seeded prompt into a credential leak.
 */
export function buildFixPrompt(input: {
	owner: string
	repo: string
	prNumber: number
	checkName: string
	prTitle: string
	headBranch: string
	prUrl?: string | null
	detailsUrl?: string | null
	headSha?: string | null
	logExcerpt?: string | null
	summary?: string | null
}): string {
	const lines = [
		`CI is failing on the pull request you opened: ${input.owner}/${input.repo}#${input.prNumber} — ${input.prTitle}.`,
		'',
		`Failing check: ${input.checkName}`,
		`Branch: ${input.headBranch}`,
		input.headSha ? `Commit: ${input.headSha}` : null,
		input.prUrl ? `Pull request: ${input.prUrl}` : null,
		input.detailsUrl ? `Check details: ${redactSecrets(input.detailsUrl)}` : null,
		input.summary ? `\nCheck summary:\n${redactSecrets(input.summary).slice(0, 1_000)}` : null,
		input.logExcerpt ? `\nLog excerpt (tail):\n\`\`\`\n${redactSecrets(input.logExcerpt)}\n\`\`\`` : null,
		'',
		'Diagnose the failure first and say what actually broke.',
		'If the failure is unrelated to this branch (a flake, an outage, a pre-existing failure on the base branch), say so and stop — do not propose rewriting working code to chase it.',
		'This run cannot edit files, run commands or push. If the branch needs a change, propose it as a patch (a unified diff of the files it touches) and say why, for the operator to apply.',
	]
	return lines.filter((line) => line !== null).join('\n')
}

/**
 * The tool policy a CI fix run is given, next to the prompt it is seeded with.
 *
 * A fix run goes through the old loop (`pr-fix.server.ts`), where an unattended run is
 * offered `web_search` alone since `run_code` was retired (#69; `$lib/runtime/detached-tools`).
 * It has no way to touch the checkout, so this and `buildFixPrompt` ask for a diagnosis and
 * a proposed patch rather than an edit. When fix runs move onto the chat engine and get file
 * tools back, both go back to "fix it on this branch".
 */
export const CI_FIX_POLICY = [
	'CI fix policy:',
	'- A continuous-integration check failed on a pull request you opened; no user is watching in real time.',
	'- Diagnose first. Say what broke and why before you propose any change.',
	'- If the failure is unrelated to this branch, report that and stop rather than proposing to rewrite working code.',
	'- This run cannot edit files, run commands or push. Propose any fix as a patch (a unified diff) with its reasoning; the operator applies it and pushes.',
].join('\n')

// ─────────── Watch lifecycle ───────────

/**
 * Map GitHub's PR state onto our enum. GitHub reports a merge as `state: 'closed'` with
 * `merged: true`, same as the webhook path does — kept in step with `mapPullRequestStatus`.
 */
export function mapProviderPullRequestState(input: {
	state: string
	merged: boolean
	draft: boolean
}): PullRequestStatus {
	if (input.merged) return 'merged'
	if (input.state === 'closed') return 'closed'
	return input.draft ? 'draft' : 'open'
}

/** Only PRs that could still go red are worth an API call. Merged and closed are done. */
export function isWatchablePullRequestStatus(status: PullRequestStatus): boolean {
	return status === 'open' || status === 'draft'
}

/** The wall-clock cap. Every watcher expires; #33's first rule, applied to a PR. */
export function isWatchWindowOpen(createdAt: Date | string, now: Date = new Date()): boolean {
	const created = createdAt instanceof Date ? createdAt : new Date(createdAt)
	if (Number.isNaN(created.getTime())) return false
	return now.getTime() - created.getTime() < PR_WATCH_MAX_AGE_MS
}

/** Why a poll decided to stop or skip — recorded on the job result for forensics. */
export type WatchStopReason = 'merged' | 'closed' | 'window_expired' | 'no_connection' | 'not_github'
