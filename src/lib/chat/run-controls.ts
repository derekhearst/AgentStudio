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

/**
 * What to tell the user when an Allow or Deny answer was not recorded, or null when it was.
 *
 * `/tool-approve` answers a token it cannot find with a 200 and `resolved: false`, and the
 * page used to read only the status: the card showed "approved" while the call went on
 * waiting and was later recorded as a denial. The card now keeps its buttons unless the
 * answer actually landed.
 */
export function approvalAnswerProblem(ok: boolean, status: number, body: unknown): string | null {
	if (!ok) return `The answer could not be sent (status ${status}). Try again.`
	const answer = (body && typeof body === 'object' ? body : {}) as { resolved?: unknown }
	if (answer.resolved === true) return null
	return 'That approval is no longer waiting for an answer. It may have timed out, or been answered in another tab.'
}

/**
 * What to tell the user when an `ask_user` answer was not recorded, or null when it was.
 *
 * `/ask-user` answers a token it cannot find with a 200 and `resolved: false`, and the page
 * read only the status: the modal closed as if the answer had been taken, and the answer
 * went nowhere. Unlike an approval, a question is only shown once it is recorded, so a
 * `resolved: false` means it is gone — timed out, answered in another tab, or its turn
 * ended — and `gone` says there is nothing to retry.
 */
export function askUserAnswerProblem(
	ok: boolean,
	status: number,
	body: unknown,
): { message: string; gone: boolean } | null {
	if (!ok) return { message: `The answer could not be sent (status ${status}). Try again.`, gone: false }
	const answer = (body && typeof body === 'object' ? body : {}) as { resolved?: unknown }
	if (answer.resolved === true) return null
	return {
		message: 'That question is no longer waiting for an answer. It may have timed out, or been answered in another tab.',
		gone: true,
	}
}
