import { json, type RequestHandler } from '@sveltejs/kit'
import { and, eq } from 'drizzle-orm'
import { env } from '$env/dynamic/private'
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
	const secret = env.GITHUB_WEBHOOK_SECRET
	if (!secret) {
		console.warn('[github-webhook] received delivery but GITHUB_WEBHOOK_SECRET is not configured — rejecting')
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
		console.error('[github-webhook] handler failed', { eventName, error: err })
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
		}).catch((err) => console.warn('[github-webhook] inbox handoff failed', err))
	}

	return { ok: true, updated: updated > 0, status: newStatus ?? 'unchanged' }
}

async function handleCheckRunEvent(payload: unknown): Promise<{ ok: boolean; recorded: number }> {
	const fields = extractCheckRunEventFields(payload)
	if (!fields) return { ok: true, recorded: 0 }
	if (fields.prNumbers.length === 0) return { ok: true, recorded: 0 }

	const repos = await db
		.select()
		.from(repositories)
		.where(and(eq(repositories.owner, fields.owner), eq(repositories.name, fields.repo)))
	if (repos.length === 0) return { ok: true, recorded: 0 }

	let recorded = 0
	for (const repo of repos) {
		for (const prNumber of fields.prNumbers) {
			const [pr] = await db
				.select({ id: pullRequests.id })
				.from(pullRequests)
				.where(and(eq(pullRequests.repositoryId, repo.id), eq(pullRequests.providerPrNumber, prNumber)))
				.limit(1)
			if (!pr) continue
			await recordPullRequestCheck({
				pullRequestId: pr.id,
				checkName: fields.checkName,
				status: fields.status,
				detailsUrl: fields.detailsUrl,
				startedAt: fields.startedAt ? new Date(fields.startedAt) : null,
				finishedAt: fields.finishedAt ? new Date(fields.finishedAt) : null,
				metadata: { source: 'github_webhook', action: fields.action },
			})
			recorded++
		}
	}

	// Tree-shake guard: imported but only used through the typed schema reference.
	void pullRequestChecks
	return { ok: true, recorded }
}
