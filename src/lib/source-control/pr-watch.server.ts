import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { logger } from '$lib/observability/logger'
import {
	fetchActionsJobLog,
	getPullRequestFromProvider,
	listCheckRunsForRef,
	listCommitStatusesForRef,
	GithubApiError,
} from './github-api.server'
import { getActiveGithubConnection } from './github-provider.server'
import {
	checkFailureDedupeKey,
	dedupeChecksByName,
	extractLogExcerpt,
	isWatchablePullRequestStatus,
	isWatchWindowOpen,
	mapProviderPullRequestState,
	normalizeCheckRun,
	normalizeCommitStatus,
	redactSecrets,
	shouldNotifyFailure,
	summarizeCheckFailure,
	PR_WATCH_MAX_AGE_DAYS,
	PR_WATCH_MAX_AGE_MS,
	PR_WATCH_MAX_LOG_FETCHES_PER_POLL,
	PR_WATCH_MAX_PRS_PER_TICK,
	type NormalizedCheck,
	type WatchStopReason,
} from './pr-checks'
import {
	pullRequests,
	repositories,
	type PullRequestRow,
	type RepositoryRow,
} from './source-control.schema'
import {
	getPullRequestCheckByName,
	markConnectionStatus,
	recordPullRequestCheck,
	syncPullRequestProviderState,
} from './source-control.server'

/**
 * #20 — watch CI after the agent opens a pull request.
 *
 * `create_pull_request` recorded the PR and then nothing ever looked at it again. This
 * module is the thing that looks.
 *
 * Two triggers, one reconciliation. A configured webhook is the better trigger — it is
 * immediate and costs no API quota — so `/api/webhooks/github` calls
 * `recordCheckObservation` directly on every `check_run` delivery. Polling is the fallback
 * for the (common) case where no webhook is configured, and it calls the SAME function.
 * Everything that decides what a check MEANS lives in `pr-checks.ts`, so the two paths
 * cannot drift into disagreeing about whether something failed.
 *
 * Why this is not a monitor (#33), despite #20 suggesting it should be:
 *
 *   - A monitor observes through a read-only tool allowlist and its evaluation path is
 *     deliberately side-effect-free. #20's core requirement is a WRITE — reconciling N
 *     `pull_request_checks` rows per poll. That write has no home in the monitor pipeline
 *     except by smuggling it into a tool that promises not to have one.
 *   - A monitor's debounce is one boolean on one row. A PR has N checks, and their names
 *     are not known until the first poll, so one latch cannot debounce them
 *     independently — and per-check debounce is exactly what "don't flood /review" means.
 *   - A monitor retires on a deadline, a fire, or a spent budget. It has no "retire
 *     because the thing being watched reached a terminal state" branch, so a watch on a
 *     merged PR would burn its check budget and then open a spurious `monitor_fired`
 *     row complaining it never fired.
 *   - "Fix it" has to land in the ORIGINATING conversation (`pull_requests.runId` exists
 *     precisely so it can), and it is offered to the operator rather than fired
 *     automatically. `start_conversation` always starts a new one, unconditionally.
 *
 * What we did take from #33 is its discipline, reimplemented at the right granularity:
 * edge-triggered notification per (check, commit), a hard wall-clock window on the watch,
 * and bounded work per tick. A user who wants the fuzzy version — "tell me when this PR
 * goes green" — can still express that as a monitor; this is the durable, structured half.
 */

export type CheckObservationOutcome = {
	checkName: string
	status: string
	recorded: boolean
	notified: boolean
	reviewItemId?: string | null
}

// ─────────── The shared reconciliation ───────────

/**
 * Record one observed check against a PR, and shout if — and only if — this is the first
 * time we have seen this check red on this commit.
 *
 * The read-before-upsert is what makes the edge detectable at all: `recordPullRequestCheck`
 * is an upsert, so by the time it returns, the evidence of what we previously believed is
 * gone. Reading first costs one indexed lookup per check and is the entire anti-flood
 * mechanism.
 *
 * `fetchExcerpt` is injected rather than imported so the webhook path can pass one that
 * uses that user's token, and a caller with no token (or no budget for another round trip)
 * can pass nothing and still get a usable review item from the check's own summary.
 */
export async function recordCheckObservation(input: {
	pr: PullRequestRow
	repo: RepositoryRow
	check: NormalizedCheck
	trigger: 'poll' | 'webhook'
	fetchExcerpt?: (check: NormalizedCheck) => Promise<string | null>
}): Promise<CheckObservationOutcome> {
	const { pr, repo, check, trigger } = input

	const previousRow = await getPullRequestCheckByName(pr.id, check.checkName)
	const previous = previousRow
		? {
				status: previousRow.status,
				headSha: (previousRow.metadata as { headSha?: string } | null)?.headSha ?? null,
			}
		: null
	const notify = shouldNotifyFailure({ next: check, previous })

	let logExcerpt: string | null = null
	if (notify && input.fetchExcerpt) {
		try {
			logExcerpt = await input.fetchExcerpt(check)
		} catch (err) {
			// A missing log is not a reason to swallow a real failure.
			logger.warn('[pr-watch] log excerpt fetch failed (non-fatal)', {
				prId: pr.id,
				checkName: check.checkName,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	await recordPullRequestCheck({
		pullRequestId: pr.id,
		checkName: check.checkName,
		status: check.status,
		detailsUrl: check.detailsUrl,
		startedAt: check.startedAt ? new Date(check.startedAt) : null,
		finishedAt: check.finishedAt ? new Date(check.finishedAt) : null,
		metadata: {
			source: trigger === 'webhook' ? 'github_webhook' : 'pr_watch_poll',
			headSha: check.headSha,
			conclusion: check.conclusion,
			externalId: check.externalId,
			checkSource: check.source,
			// Every CI-authored string is scrubbed on the way IN, so the row itself is safe
			// to read back into a prompt, an inbox payload or a debug dump later. The
			// excerpt arrived pre-scrubbed from `extractLogExcerpt`; re-running it is
			// idempotent and keeps the guarantee local to this write.
			...(check.outputTitle ? { outputTitle: redactSecrets(check.outputTitle).slice(0, 500) } : {}),
			...(check.outputSummary ? { outputSummary: redactSecrets(check.outputSummary).slice(0, 2_000) } : {}),
			...(logExcerpt ? { logExcerpt: redactSecrets(logExcerpt) } : {}),
			...(notify ? { notifiedAt: new Date().toISOString() } : {}),
		},
	})

	if (!notify) {
		return { checkName: check.checkName, status: check.status, recorded: true, notified: false }
	}

	const reviewItemId = await raiseCheckFailure({ pr, repo, check, logExcerpt, trigger })
	return {
		checkName: check.checkName,
		status: check.status,
		recorded: true,
		notified: true,
		reviewItemId,
	}
}

/**
 * Open the review item and send the notification for a newly-failing check.
 *
 * Both are best-effort and independently so: a review row that fails to insert must not
 * cost the push, and a push that fails (VAPID unconfigured is the normal case on a fresh
 * box) must not cost the review row. The review row is the durable half and goes first.
 */
async function raiseCheckFailure(input: {
	pr: PullRequestRow
	repo: RepositoryRow
	check: NormalizedCheck
	logExcerpt: string | null
	trigger: 'poll' | 'webhook'
}): Promise<string | null> {
	const { pr, repo, check } = input
	const summary = summarizeCheckFailure({
		owner: repo.owner,
		repo: repo.name,
		prNumber: pr.providerPrNumber,
		checkName: check.checkName,
		title: check.outputTitle,
	})

	let reviewItemId: string | null = null
	try {
		const { openReviewItem } = await import('$lib/observability/review.server')
		const item = await openReviewItem({
			type: 'pull_request_checks_failed',
			severity: 'warning',
			summary,
			// `runId` points at the run that opened the PR, which is what makes the inbox
			// row navigable back to where the work happened.
			runId: pr.runId ?? null,
			payload: {
				kind: 'pull_request_check_failure',
				pullRequestId: pr.id,
				owner: repo.owner,
				repo: repo.name,
				prNumber: pr.providerPrNumber,
				prTitle: pr.title,
				prUrl: pr.providerUrl,
				headBranch: pr.headBranch,
				headSha: check.headSha,
				checkName: check.checkName,
				conclusion: check.conclusion,
				// Every CI-authored field in this payload is scrubbed. The payload is
				// rendered verbatim in /review's expanded row, so it is the single most
				// visible place a leaked credential could land.
				detailsUrl: check.detailsUrl ? redactSecrets(check.detailsUrl) : null,
				outputTitle: check.outputTitle ? redactSecrets(check.outputTitle).slice(0, 500) : null,
				outputSummary: check.outputSummary ? redactSecrets(check.outputSummary).slice(0, 1_000) : null,
				logExcerpt: input.logExcerpt ? redactSecrets(input.logExcerpt) : null,
				trigger: input.trigger,
				originatingRunId: pr.runId,
				// Read by /review to render the "Fix it" button. The inbox stays generic; it
				// just knows that a payload carrying `fixCommand` has an action available.
				fixCommand: 'pr_fix',
			},
			dedupeKey: checkFailureDedupeKey({
				owner: repo.owner,
				repo: repo.name,
				prNumber: pr.providerPrNumber,
				checkName: check.checkName,
				headSha: check.headSha,
			}),
		})
		reviewItemId = item?.id ?? null
	} catch (err) {
		logger.warn('[pr-watch] review item failed (non-fatal)', { prId: pr.id, err })
	}

	try {
		const { createNotificationRecord, sendPushToAll } = await import('$lib/notifications/notifications.server')
		const payload = {
			title: `CI failed on #${pr.providerPrNumber}`,
			// `checkName` is workflow-authored rather than build output, so it is far less
			// likely to carry anything — but a push notification goes to a lock screen,
			// which is the one surface the operator cannot redact after the fact, so it
			// gets the same scrub as everything else.
			body: redactSecrets(`${check.checkName} — ${repo.owner}/${repo.name}: ${pr.title}`).slice(0, 400),
			url: '/review',
			// One notification slot per (PR, check): a re-fire replaces the banner instead
			// of stacking another one on the operator's lock screen.
			tag: `pr-check-${pr.id}-${check.checkName}`,
		}
		if (repo.userId) {
			await createNotificationRecord(payload, repo.userId)
			await sendPushToAll(payload, repo.userId).catch(() => undefined)
		}
	} catch (err) {
		logger.warn('[pr-watch] notification failed (non-fatal)', { prId: pr.id, err })
	}

	return reviewItemId
}

// ─────────── The polling fallback ───────────

export type WatchablePullRequest = { pr: PullRequestRow; repo: RepositoryRow }

/**
 * PRs worth an API call right now: recorded against one of the user's GitHub repos, still
 * open or draft, and inside the watch window.
 *
 * Note what is NOT here: any per-PR watch state. Whether a PR is watched is derived from
 * the PR row itself, which means a merge recorded by the webhook stops the polling with no
 * second bookkeeping step to forget, and there is no watch table to leak rows into.
 */
export async function listWatchablePullRequests(
	now = new Date(),
	limit = PR_WATCH_MAX_PRS_PER_TICK,
): Promise<WatchablePullRequest[]> {
	const cutoff = new Date(now.getTime() - PR_WATCH_MAX_AGE_MS)
	const rows = await db
		.select({ pr: pullRequests, repo: repositories })
		.from(pullRequests)
		.innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
		.where(
			and(
				inArray(pullRequests.status, ['open', 'draft']),
				eq(repositories.provider, 'github'),
				isNotNull(repositories.userId),
				gte(pullRequests.createdAt, cutoff),
			),
		)
		// Oldest-updated first: a backlog larger than one tick drains fairly instead of
		// starving the same tail every time.
		.orderBy(pullRequests.updatedAt)
		.limit(limit)
	return rows.map((row) => ({ pr: row.pr, repo: row.repo }))
}

export type PollPullRequestResult = {
	pullRequestId: string
	status: string
	stopped?: WatchStopReason
	checksObserved: number
	failuresNotified: number
	outcomes: CheckObservationOutcome[]
}

/**
 * One poll of one PR.
 *
 * Order matters: the PR's own state is read FIRST. A PR that merged since the last tick
 * should stop being watched without spending a second call on its checks, and — more
 * importantly — without opening a review item about a check that failed on a branch that
 * no longer matters.
 */
export async function pollPullRequestChecks(
	pullRequestId: string,
	now = new Date(),
): Promise<PollPullRequestResult> {
	const [row] = await db
		.select({ pr: pullRequests, repo: repositories })
		.from(pullRequests)
		.innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
		.where(eq(pullRequests.id, pullRequestId))
		.limit(1)
	if (!row) throw new Error(`Pull request ${pullRequestId} not found`)

	const { pr, repo } = row
	const empty = { pullRequestId, checksObserved: 0, failuresNotified: 0, outcomes: [] as CheckObservationOutcome[] }

	if (repo.provider !== 'github') return { ...empty, status: pr.status, stopped: 'not_github' }
	if (!isWatchablePullRequestStatus(pr.status)) {
		return { ...empty, status: pr.status, stopped: pr.status === 'merged' ? 'merged' : 'closed' }
	}
	if (!isWatchWindowOpen(pr.createdAt, now)) {
		return { ...empty, status: pr.status, stopped: 'window_expired' }
	}
	if (!repo.userId) return { ...empty, status: pr.status, stopped: 'no_connection' }

	const conn = await getActiveGithubConnection(repo.userId)
	if (!conn) return { ...empty, status: pr.status, stopped: 'no_connection' }

	let providerState
	try {
		providerState = await getPullRequestFromProvider(conn.accessToken, repo.owner, repo.name, pr.providerPrNumber)
	} catch (err) {
		// A revoked or expired token is a connection problem, not a PR problem — flip the
		// connection so `getActiveGithubConnection` stops handing it out and every other
		// watched PR skips instead of hammering a 401. Never log the token itself.
		if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
			await markConnectionStatus(conn.connection.id, 'error', err.message)
		}
		throw err
	}

	const mappedStatus = mapProviderPullRequestState({
		state: providerState.state,
		merged: providerState.merged,
		draft: providerState.draft,
	})
	await syncPullRequestProviderState({
		pullRequestId: pr.id,
		status: mappedStatus,
		providerUrl: providerState.htmlUrl || pr.providerUrl,
		mergedAt: providerState.mergedAt ? new Date(providerState.mergedAt) : null,
		closedAt: providerState.closedAt ? new Date(providerState.closedAt) : null,
		headSha: providerState.headSha,
		metadata: { lastPolledAt: now.toISOString(), watchSource: 'pr_watch_poll' },
	})

	// Stop watching on merge/close — the whole point of reading state first.
	if (!isWatchablePullRequestStatus(mappedStatus)) {
		return {
			...empty,
			status: mappedStatus,
			stopped: mappedStatus === 'merged' ? 'merged' : 'closed',
		}
	}

	const ref = providerState.headSha ?? pr.headBranch
	const [checkRuns, commitStatuses] = await Promise.all([
		listCheckRunsForRef(conn.accessToken, repo.owner, repo.name, ref),
		listCommitStatusesForRef(conn.accessToken, repo.owner, repo.name, ref).catch(() => []),
	])

	const checks = dedupeChecksByName([
		...checkRuns.map((raw) => normalizeCheckRun(raw, providerState.headSha)),
		...commitStatuses.map((raw) => normalizeCommitStatus(raw, providerState.headSha)),
	].filter((check): check is NormalizedCheck => check !== null))

	// Log downloads are the expensive call, so they are rationed per poll. Failures beyond
	// the cap still get a review item, just with the check's own summary instead of a tail.
	let logFetches = 0
	const fetchExcerpt = async (check: NormalizedCheck): Promise<string | null> => {
		if (check.externalId === null) return null
		if (logFetches >= PR_WATCH_MAX_LOG_FETCHES_PER_POLL) return null
		logFetches += 1
		const raw = await fetchActionsJobLog(conn.accessToken, repo.owner, repo.name, check.externalId)
		return raw ? extractLogExcerpt(raw) : null
	}

	const outcomes: CheckObservationOutcome[] = []
	// Refreshed PR row so the review item carries the state we just recorded.
	const prForObservation: PullRequestRow = { ...pr, status: mappedStatus, providerUrl: providerState.htmlUrl || pr.providerUrl }
	for (const check of checks) {
		try {
			outcomes.push(
				await recordCheckObservation({ pr: prForObservation, repo, check, trigger: 'poll', fetchExcerpt }),
			)
		} catch (err) {
			// One malformed check must not abandon the rest of the PR's checks.
			logger.warn('[pr-watch] check observation failed', {
				prId: pr.id,
				checkName: check.checkName,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return {
		pullRequestId,
		status: mappedStatus,
		checksObserved: outcomes.length,
		failuresNotified: outcomes.filter((o) => o.notified).length,
		outcomes,
	}
}

export type DispatchPullRequestWatchResult = {
	runAt: string
	watchable: number
	enqueued: number
	errors: number
	windowDays: number
}

/**
 * The tick. Cheap by construction: one indexed join, then one enqueue per watchable PR.
 * No GitHub call happens here — a tick that fans out to nothing costs a single query.
 */
export async function dispatchPullRequestWatch(now = new Date()): Promise<DispatchPullRequestWatchResult> {
	const watchable = await listWatchablePullRequests(now)
	let enqueued = 0
	let errors = 0

	if (watchable.length > 0) {
		const { enqueueJob } = await import('$lib/jobs/jobs.server')
		// Minute-bucketed dedupe key, `forever`: a double tick (two schedulers, a manual cron
		// hit) collapses onto one job row rather than double-polling the API, even when the
		// first poll has already finished.
		const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()
		for (const { pr, repo } of watchable) {
			try {
				await enqueueJob({
					type: 'pr_watch',
					queue: 'default',
					// Background work, but a late CI report is a stale CI report.
					priority: 55,
					dedupeKey: `pr_watch:${pr.id}:${bucket}`,
					dedupeScope: 'forever',
					payload: { pullRequestId: pr.id },
					runId: pr.runId ?? undefined,
					userId: repo.userId ?? undefined,
				})
				enqueued += 1
			} catch (err) {
				errors += 1
				logger.warn('[pr-watch] enqueue failed', {
					prId: pr.id,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}

	return {
		runAt: now.toISOString(),
		watchable: watchable.length,
		enqueued,
		errors,
		windowDays: PR_WATCH_MAX_AGE_DAYS,
	}
}
