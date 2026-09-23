/**
 * The chat page's stop controls, as requests. Browser-side; the server half is
 * `/chat/[id]/stop`.
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

