import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PullRequestStatus, PullRequestCheckStatus } from './source-control.schema'

/**
 * Wave 5 #19 phase 5 — GitHub webhook ingestion helpers.
 *
 * Pure utilities (no DB / network) for the public `/api/webhooks/github` endpoint:
 *   - HMAC signature verification with timing-safe compare
 *   - Action → PullRequestStatus mapping (open/closed/merged/draft)
 *   - check_run status/conclusion → PullRequestCheckStatus mapping
 *   - Field extraction from the (somewhat ad-hoc) GitHub event payload shape
 *
 * The route side wraps these with the source-control upserts; keeping the parsing pure
 * lets the route be a thin transport layer and lets unit tests pin the contracts against
 * fixed sample payloads (the GitHub event schemas are stable enough for our needs).
 */

const SIGNATURE_PREFIX = 'sha256='

/**
 * Verify a GitHub webhook delivery against its X-Hub-Signature-256 header.
 *
 * - `rawBody` MUST be the exact bytes received in the POST body — JSON parse → re-serialize
 *   would change whitespace and break the HMAC.
 * - `signatureHeader` is the literal value of `X-Hub-Signature-256` (e.g. `sha256=abc…`).
 *   Missing header / wrong prefix / wrong-length hex → false.
 * - `secret` is the shared secret configured in the GitHub webhook settings + on this side
 *   via the `GITHUB_WEBHOOK_SECRET` env var.
 *
 * Uses `timingSafeEqual` to defend against timing-side-channel attacks on the comparison.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
	if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false
	if (!secret) return false

	const provided = signatureHeader.slice(SIGNATURE_PREFIX.length)
	if (provided.length === 0) return false

	const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
	if (provided.length !== expected.length) return false

	const a = Buffer.from(provided, 'hex')
	const b = Buffer.from(expected, 'hex')
	if (a.length !== b.length || a.length === 0) return false
	return timingSafeEqual(a, b)
}

/**
 * Map a `pull_request` event's action (+ merged/draft flags) to our PR status enum.
 *
 * GitHub fires `closed` with `merged=true` for merges and `merged=false` for plain closes
 * — same action, two outcomes. `synchronize` and `edited` don't change status (caller
 * passes `null` so a row update can leave the column untouched). Action `reopened` of a
 * draft PR re-opens as `draft`; non-draft reopens become `open`.
 */
export function mapPullRequestStatus(
	action: string,
	merged: boolean,
	draft: boolean,
): PullRequestStatus | null {
	switch (action) {
		case 'opened':
		case 'reopened':
		case 'ready_for_review':
			return draft ? 'draft' : 'open'
		case 'converted_to_draft':
			return 'draft'
		case 'closed':
			return merged ? 'merged' : 'closed'
		case 'edited':
		case 'synchronize':
		case 'labeled':
		case 'unlabeled':
		case 'assigned':
		case 'unassigned':
		case 'review_requested':
		case 'review_request_removed':
			// Status-irrelevant updates: caller leaves status unchanged on the row.
			return null
		default:
			return null
	}
}

/**
 * Map a `check_run` event's status + conclusion to our check status enum.
 * Mid-flight checks have `conclusion=null`; we fall back to GitHub's `status`.
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

export type PullRequestEventFields = {
	action: string
	owner: string
	repo: string
	prNumber: number
	title: string
	body: string | null
	headBranch: string
	baseBranch: string
	htmlUrl: string
	merged: boolean
	draft: boolean
	mergedAt: string | null
	closedAt: string | null
}

/**
 * Pull the fields we care about out of a `pull_request` event payload.
 * Returns null for malformed payloads (missing action, missing pull_request object, etc.)
 * so the route can 200 the delivery and move on without crashing the worker.
 */
export function extractPullRequestEventFields(payload: unknown): PullRequestEventFields | null {
	if (!payload || typeof payload !== 'object') return null
	const root = payload as Record<string, unknown>
	const action = typeof root.action === 'string' ? root.action : null
	const pr = root.pull_request as Record<string, unknown> | undefined
	const repository = root.repository as Record<string, unknown> | undefined
	if (!action || !pr || !repository) return null

	const owner = (repository.owner as Record<string, unknown> | undefined)?.login
	const repoName = repository.name
	const prNumber = pr.number
	const title = pr.title
	const head = pr.head as Record<string, unknown> | undefined
	const base = pr.base as Record<string, unknown> | undefined
	const headBranch = head?.ref
	const baseBranch = base?.ref
	const htmlUrl = pr.html_url
	if (
		typeof owner !== 'string' ||
		typeof repoName !== 'string' ||
		typeof prNumber !== 'number' ||
		typeof title !== 'string' ||
		typeof headBranch !== 'string' ||
		typeof baseBranch !== 'string' ||
		typeof htmlUrl !== 'string'
	) {
		return null
	}

	return {
		action,
		owner,
		repo: repoName,
		prNumber,
		title,
		body: typeof pr.body === 'string' ? pr.body : null,
		headBranch,
		baseBranch,
		htmlUrl,
		merged: pr.merged === true,
		draft: pr.draft === true,
		mergedAt: typeof pr.merged_at === 'string' ? pr.merged_at : null,
		closedAt: typeof pr.closed_at === 'string' ? pr.closed_at : null,
	}
}

export type CheckRunEventFields = {
	action: string
	owner: string
	repo: string
	checkName: string
	status: PullRequestCheckStatus
	detailsUrl: string | null
	startedAt: string | null
	finishedAt: string | null
	prNumbers: number[]
}

/**
 * Pull the fields we care about out of a `check_run` event payload. The check is
 * potentially attached to multiple PRs (the `pull_requests` array on the check_run),
 * so we return the list and let the caller fan out the upsert.
 */
export function extractCheckRunEventFields(payload: unknown): CheckRunEventFields | null {
	if (!payload || typeof payload !== 'object') return null
	const root = payload as Record<string, unknown>
	const action = typeof root.action === 'string' ? root.action : null
	const checkRun = root.check_run as Record<string, unknown> | undefined
	const repository = root.repository as Record<string, unknown> | undefined
	if (!action || !checkRun || !repository) return null

	const owner = (repository.owner as Record<string, unknown> | undefined)?.login
	const repoName = repository.name
	const checkName = checkRun.name
	const ghStatus = checkRun.status
	const conclusion = checkRun.conclusion
	if (
		typeof owner !== 'string' ||
		typeof repoName !== 'string' ||
		typeof checkName !== 'string' ||
		typeof ghStatus !== 'string'
	) {
		return null
	}

	const status = mapCheckRunStatus({
		status: ghStatus,
		conclusion: typeof conclusion === 'string' ? conclusion : null,
	})

	const prNumbers: number[] = []
	const prs = checkRun.pull_requests
	if (Array.isArray(prs)) {
		for (const pr of prs) {
			const num = (pr as Record<string, unknown>)?.number
			if (typeof num === 'number') prNumbers.push(num)
		}
	}

	return {
		action,
		owner,
		repo: repoName,
		checkName,
		status,
		detailsUrl: typeof checkRun.details_url === 'string' ? checkRun.details_url : null,
		startedAt: typeof checkRun.started_at === 'string' ? checkRun.started_at : null,
		finishedAt: typeof checkRun.completed_at === 'string' ? checkRun.completed_at : null,
		prNumbers,
	}
}
