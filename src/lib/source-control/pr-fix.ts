/**
 * #20 — pure rules around the "Fix it" button, shared by the remote command, the `pr_fix`
 * job and the inbox UI. No database, no SvelteKit, so specs import it directly.
 */

/**
 * Whether `userId` may start a fix run on a pull request whose repository is owned by
 * `repositoryUserId`. A repository with no recorded owner predates per-user repositories
 * and stays fixable, which is what the job has always allowed.
 *
 * The command asks this BEFORE queueing, not only the job afterwards: the job's dedupe key
 * is per review item and unique forever, so a refused press that still enqueued would take
 * the item's one fix run with a job that can only fail.
 */
export function mayFixPullRequest(repositoryUserId: string | null, userId: string): boolean {
	return !repositoryUserId || repositoryUserId === userId
}

const IN_FLIGHT = new Set(['pending', 'leased', 'running', 'retry_wait'])

/**
 * What to tell the operator after pressing "Fix it", from the job the press came back with.
 *
 * Pressing twice on the same review item hands back the FIRST job — by design, one fix run
 * per failure — so the answer can be a run that already finished or already failed. The
 * button used to say "Fix run queued" regardless, which is how a failed first run looked
 * like a fresh one that never replied.
 */
export function describeFixRunJob(job: { jobId: string; status: string }): string {
	const ref = `job ${job.jobId.slice(0, 8)}`
	if (IN_FLIGHT.has(job.status)) {
		return `Fix run queued (${ref}). The agent replies in the conversation that opened the pull request.`
	}
	if (job.status === 'completed') {
		return `A fix run for this failure already finished (${ref}). Its reply is in the conversation that opened the pull request.`
	}
	return `A fix run for this failure already ran and ended as ${job.status} (${ref}); Settings → Jobs has the reason. Each failure gets one fix run; a new failure on the pull request opens a new item.`
}
