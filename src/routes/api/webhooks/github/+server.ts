import { json, type RequestHandler } from '@sveltejs/kit'
import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { repositories, pullRequests, pullRequestChecks } from '$lib/source-control/source-control.schema'
import {
	extractCheckRunEventFields,
	extractPullRequestEventFields,
	mapPullRequestStatus,
	verifyWebhookSignature,
} from '$lib/source-control/github-webhook'
import { recordPullRequest, recordPullRequestCheck } from '$lib/source-control/source-control.server'
import { openReviewItem } from '$lib/observability/review.server'
import { logger } from '$lib/observability/logger'
import { getGithubWebhookSecret } from '$lib/server/config'

/**
 * Wave 5 #19 phase 5 — public GitHub webhook receiver.
 *
 * GitHub POSTs here when a configured webhook fires. We:
 *   1. Read the raw body (HMAC needs exact bytes — JSON.parse → JSON.stringify changes them).
 *   2. Verify the X-Hub-Signature-256 header against `GITHUB_WEBHOOK_SECRET`.
 *   3. Dispatch by `X-GitHub-Event` header to the matching pure helper.
 *   4. Reconcile DB rows (pull_requests + pull_request_checks) by-name on (owner, repo, prNumber).
 *
 * Secret rotation: missing/empty `GITHUB_WEBHOOK_SECRET` means we ALWAYS reject (operator
 * never accidentally serves an unauthenticated webhook endpoint to the internet). The
 * operator opts in by setting the env var + the matching secret on GitHub's side.
 *
 * `ping` events return 200 with `{ok: true}` so GitHub's "Recent Deliveries" tab shows green.
 * Unknown events return 200 with `{ignored: true}` so GitHub doesn't retry forever — we
 * intentionally only handle a small subset.
 */

export const POST: RequestHandler = async ({ request }) => {
	const secret = getGithubWebhookSecret()
	if (!secret) {
		logger.warn('[github-webhook] received delivery but GITHUB_WEBHOOK_SECRET is not configured — rejecting')
		return json({ error: 'webhook not configured' }, { status: 503 })
	}

	const rawBody = await request.text()
	const signature = request.headers.get('x-hub-signature-256')
	if (!verifyWebhookSignature(rawBody, signature, secret)) {
		return json({ error: 'invalid signature' }, { status: 401 })
	}

	const eventName = request.headers.get('x-github-event') ?? 'unknown'
	let payload: unknown
	try {
		payload = JSON.parse(rawBody)
	} catch {
		return json({ error: 'malformed body' }, { status: 400 })
	}

	if (eventName === 'ping') {
		return json({ ok: true, pong: true })
	}

	try {
		if (eventName === 'pull_request') {
			const result = await handlePullRequestEvent(payload)
			return json(result)
		}
		if (eventName === 'check_run') {
			const result = await handleCheckRunEvent(payload)
			return json(result)
		}
	} catch (err) {
		logger.error('[github-webhook] handler failed', { eventName, error: err })
		// 200 with an error marker so GitHub doesn't disable the webhook on transient
		// DB hiccups — the failure is logged for diagnostics.
		return json({ ok: false, error: err instanceof Error ? err.message : String(err) })
	}

	return json({ ignored: true, eventName })
}

async function handlePullRequestEvent(payload: unknown): Promise<{ ok: boolean; updated: boolean; status?: string }> {
	const fields = extractPullRequestEventFields(payload)
	if (!fields) return { ok: true, updated: false }

	// Match on (owner, name) globally — webhooks aren't user-scoped, so any user who has
	// connected this repo gets the update. The repository row carries userId, so we
	// reconcile per-row.
	const repos = await db
		.select()
		.from(repositories)
		.where(and(eq(repositories.owner, fields.owner), eq(repositories.name, fields.repo)))
	if (repos.length === 0) return { ok: true, updated: false }

	const newStatus = mapPullRequestStatus(fields.action, fields.merged, fields.draft)
	let updated = 0
	for (const repo of repos) {
		await recordPullRequest({
			repositoryId: repo.id,
			providerPrNumber: fields.prNumber,
			title: fields.title,
			body: fields.body,
			headBranch: fields.headBranch,
			baseBranch: fields.baseBranch,
			status: newStatus ?? undefined,
			providerUrl: fields.htmlUrl,
			metadata: {
				source: 'github_webhook',
				lastAction: fields.action,
				merged: fields.merged,
				mergedAt: fields.mergedAt,
				closedAt: fields.closedAt,
			},
		})
		updated++
	}

	// #20 — this is also how CI watching STOPS. `listWatchablePullRequests` derives
	// watchability from `pull_requests.status`, so recording the merge/close above is the
	// only thing needed to retire the watch: the next dispatch tick simply does not select
	// this row. There is no separate watch record to forget to clean up.

	// Notify the inbox on terminal transitions so the operator sees PR outcomes without
	// monitoring chat. Best-effort; dedupeKey covers re-deliveries from GitHub.
	if (newStatus === 'merged' || newStatus === 'closed') {
		void openReviewItem({
			type: 'pull_request_ready',
			severity: newStatus === 'merged' ? 'info' : 'warning',
			summary: `PR ${newStatus}: ${fields.owner}/${fields.repo}#${fields.prNumber} — ${fields.title.slice(0, 120)}`,
			payload: {
				kind: 'pull_request',
				owner: fields.owner,
				repo: fields.repo,
				prNumber: fields.prNumber,
				htmlUrl: fields.htmlUrl,
				status: newStatus,
				source: 'github_webhook',
			},
			dedupeKey: `pull_request:${fields.owner}/${fields.repo}:${fields.prNumber}:${newStatus}`,
		}).catch((err) => logger.warn('[github-webhook] inbox handoff failed', { err }))
	}

	return { ok: true, updated: updated > 0, status: newStatus ?? 'unchanged' }
}

/**
 * #20 — a `check_run` delivery is the PRIMARY CI-watch trigger where a webhook is
 * configured: immediate, and it costs no API quota. Everything past the parse is shared
 * with the polling fallback (`recordCheckObservation`), so the two triggers cannot drift
 * into disagreeing about what a check means or when it is worth telling someone.
 *
 * What this path adds over the plain upsert it replaces:
 *   - a review item + notification on the pass→fail edge, deduped per (PR, check, commit)
 *   - the head SHA, the check-run id and the check's output summary on the row
 *   - a log excerpt fetched with the repo owner's token, when we have one
 *
 * A repo whose owner has no active GitHub connection still gets its check rows written;
 * only the excerpt is omitted. A missing token degrades the detail, never the record.
 */
async function handleCheckRunEvent(payload: unknown): Promise<{ ok: boolean; recorded: number; notified: number }> {
	const fields = extractCheckRunEventFields(payload)
	if (!fields) return { ok: true, recorded: 0, notified: 0 }
	if (fields.prNumbers.length === 0) return { ok: true, recorded: 0, notified: 0 }

	const repos = await db
		.select()
		.from(repositories)
		.where(and(eq(repositories.owner, fields.owner), eq(repositories.name, fields.repo)))
	if (repos.length === 0) return { ok: true, recorded: 0, notified: 0 }

	const { recordCheckObservation } = await import('$lib/source-control/pr-watch.server')

	let recorded = 0
	let notified = 0
	for (const repo of repos) {
		for (const prNumber of fields.prNumbers) {
			const [pr] = await db
				.select()
				.from(pullRequests)
				.where(and(eq(pullRequests.repositoryId, repo.id), eq(pullRequests.providerPrNumber, prNumber)))
				.limit(1)
			if (!pr) continue
			try {
				const outcome = await recordCheckObservation({
					pr,
					repo,
					check: fields.check,
					trigger: 'webhook',
					fetchExcerpt: (check) => fetchExcerptForCheck(repo.userId, repo.owner, repo.name, check),
				})
				recorded++
				if (outcome.notified) notified++
			} catch (err) {
				// One repo row failing must not abandon the rest of the fan-out, and the
				// delivery still returns 200 so GitHub does not disable the webhook.
				logger.warn('[github-webhook] check observation failed', {
					owner: fields.owner,
					repo: fields.repo,
					prNumber,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}

	// Tree-shake guards: imported for their typed schema references only.
	void pullRequestChecks
	void recordPullRequestCheck
	return { ok: true, recorded, notified }
}

/**
 * Best-effort log tail for a failing Actions check, fetched with the repo owner's stored
 * token. Returns null for every failure mode — no connection, a non-Actions check, an
 * expired log — because a review item without an excerpt is still worth opening. The token
 * is used and discarded; it is never logged or written to the row.
 */
async function fetchExcerptForCheck(
	userId: string | null,
	owner: string,
	repo: string,
	check: { externalId: number | null },
): Promise<string | null> {
	if (!userId || check.externalId === null) return null
	try {
		const { getActiveGithubConnection } = await import('$lib/source-control/github-provider.server')
		const conn = await getActiveGithubConnection(userId)
		if (!conn) return null
		const { fetchActionsJobLog } = await import('$lib/source-control/github-api.server')
		const { extractLogExcerpt } = await import('$lib/source-control/pr-checks')
		const raw = await fetchActionsJobLog(conn.accessToken, owner, repo, check.externalId)
		return raw ? extractLogExcerpt(raw) : null
	} catch {
		return null
	}
}
