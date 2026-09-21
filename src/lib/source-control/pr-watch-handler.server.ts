import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { registerScheduledJob } from '$lib/jobs/scheduler.server'
import { PR_WATCH_DISPATCH_INTERVAL_MS } from './pr-checks'
import { dispatchPullRequestWatch, pollPullRequestChecks } from './pr-watch.server'
import { startPullRequestFixRun } from './pr-fix.server'

/**
 * #20 — how a watched PR gets looked at, and how a fix gets run.
 *
 * Three job types, laid out the same way #33's monitors are so the app has one queue story:
 *
 *   pr_watch_dispatch — a scheduled tick. One indexed join, then one `pr_watch` enqueue per
 *                       watchable PR. No network call happens here, so an idle box pays a
 *                       single query every few minutes.
 *   pr_watch          — poll one PR: reconcile its provider state, reconcile its checks,
 *                       shout about newly-red ones. Runs on the durable queue so it gets
 *                       leases, heartbeats and retries, and a failure is visible in
 *                       /settings/jobs afterwards.
 *   pr_fix            — the operator pressed "Fix it". Seeds the failure into the
 *                       originating conversation and runs the agent detached. On the queue
 *                       because it is slow and must survive the request that started it.
 *
 * The tick interval is minutes, not seconds: CI takes minutes, and every poll is 2-3
 * GitHub API calls per open PR. Where a webhook is configured it does this work for free
 * and immediately — the poll is the fallback, and polling a PR the webhook already
 * reconciled is harmless because both paths write through the same idempotent upsert.
 */

const PR_WATCH_PAYLOAD = z.object({ pullRequestId: z.string().uuid() })

const PR_FIX_PAYLOAD = z.object({
	pullRequestId: z.string().uuid(),
	userId: z.string().uuid(),
	checkName: z.string().max(400).nullable().optional(),
	reviewItemId: z.string().uuid().nullable().optional(),
})

let registered = false

export function registerPullRequestWatchJobHandlers(): void {
	if (registered) return

	registerJobHandler('pr_watch', async ({ job }) => {
		const parsed = PR_WATCH_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`pr_watch payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await pollPullRequestChecks(parsed.data.pullRequestId)
		return { ...result }
	})

	registerScheduledJob({
		name: 'source-control.pr-watch.dispatch',
		intervalMs: PR_WATCH_DISPATCH_INTERVAL_MS,
		// Offset from automations.dispatch (15s) and monitors.dispatch (25s) so the ticks
		// do not all land on the same second after a boot.
		initialDelayMs: 40_000,
		enqueue: () => ({
			type: 'pr_watch_dispatch',
			queue: 'maintenance',
			priority: 30,
			dedupeKey: 'pr_watch:dispatch',
			payload: {},
		}),
	})

	registerJobHandler('pr_watch_dispatch', async () => {
		const result = await dispatchPullRequestWatch()
		return { ...result }
	})

	registerJobHandler('pr_fix', async ({ job }) => {
		const parsed = PR_FIX_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`pr_fix payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await startPullRequestFixRun({
			pullRequestId: parsed.data.pullRequestId,
			userId: parsed.data.userId,
			checkName: parsed.data.checkName ?? null,
			reviewItemId: parsed.data.reviewItemId ?? null,
		})
		return { ...result }
	})

	registered = true
}
