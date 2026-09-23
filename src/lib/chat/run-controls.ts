/**
 * The chat page's stop controls, as requests. Browser-side; the server halves are
 * `/chat/[id]/stop` and `/chat/[id]/stop-task`.
 */

/**
 * Ask the server to stop the conversation's live run.
 *
 * Aborting the stream's fetch is no longer a stop: a dropped connection leaves the run going
 * so a reload or a network blip does not cut a turn short. Stop has to say so explicitly.
 * `runId` is null when Stop is pressed before the stream's first frame named the run, and
 * the server then stops whatever is live in the conversation.
 *
 * Never throws — the caller is tearing the stream down either way, and a stop that could
 * not be delivered is logged rather than raised over the top of that.
 */
export async function requestRunStop(conversationId: string, runId: string | null): Promise<void> {
	try {
		const response = await fetch(`/chat/${conversationId}/stop`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ runId }),
		})
		if (!response.ok) console.warn('[chat] stop request failed', response.status)
	} catch (error) {
		console.warn('[chat] stop request failed', error)
	}
}

/**
 * What to tell the user when stopping a background task did not work, or null when it did.
 *
 * `/stop-task` answers a refusal with a 200 and `stopped: false`, and the page used to ignore
 * the body: the chip's button did nothing and said nothing. `taskGone` is true when the task
 * cannot still be running — its turn has ended, and with it the process that owned it — so
 * the chip can go too.
 */
export function stopTaskProblem(ok: boolean, body: unknown): { message: string; taskGone: boolean } | null {
	const answer = (body && typeof body === 'object' ? body : {}) as { stopped?: unknown; reason?: unknown }
	if (ok && answer.stopped === true) return null

	switch (answer.reason) {
		case 'run_not_active':
			return { message: 'That task ended with its turn, so there is nothing left to stop.', taskGone: true }
		case 'not_reachable':
			return { message: 'This run is not reachable from here, so the task could not be stopped.', taskGone: false }
		case 'stop_failed':
			return { message: 'The task could not be stopped. It may already have finished.', taskGone: false }
		default:
			return { message: 'Could not stop the task. Try again in a moment.', taskGone: false }
	}
}
