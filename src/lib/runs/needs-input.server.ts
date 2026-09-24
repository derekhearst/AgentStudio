import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { logger } from '$lib/observability/logger'

/**
 * "Needs input" notifications: a run has been waiting on the user for a while.
 *
 * The toggle existed in Settings and nothing ever sent one. A run that pauses on a tool
 * approval or a question from the agent waits five minutes (`DECISION_TIMEOUT_MS`) and then
 * gives up — denying the tool, or answering "the user did not answer in time" — so a user
 * who has walked away from the chat loses the turn without knowing it was waiting.
 *
 * Not at the moment the run pauses: whoever is watching the chat answers the card in
 * seconds, and a push for every approval they are already looking at is noise. A run still
 * waiting after `NEEDS_INPUT_NOTIFY_DELAY_MS` is one nobody is watching, which leaves four
 * minutes to answer. The notification goes through `notifyUser`, so the Settings toggle
 * switches it off.
 */

export const NEEDS_INPUT_NOTIFY_DELAY_MS = 60_000

export type NeedsInputPrompt = {
	runId: string
	token: string
	kind: 'approval' | 'question'
	/** One line saying what the run is waiting for — the tool name, or the first question. */
	summary: string
}

/** Arrange for `notifyIfStillWaiting` to run once the delay has passed. */
export function scheduleNeedsInputNotification(prompt: NeedsInputPrompt, delayMs = NEEDS_INPUT_NOTIFY_DELAY_MS): void {
	const timer = setTimeout(() => {
		void notifyIfStillWaiting(prompt).catch((err) =>
			logger.warn('[runs] needs-input notification failed (non-fatal)', { err, runId: prompt.runId }),
		)
	}, delayMs)
	// A pending reminder must not keep the process alive on shutdown.
	timer.unref?.()
}

export type NeedsInputOutcome = 'notified' | 'no_longer_waiting' | 'category_off'

/**
 * Notify the run's owner if the prompt is still unanswered: the run has not ended, and its
 * entry is still pending with no decision or answers on it.
 */
export async function notifyIfStillWaiting(prompt: NeedsInputPrompt): Promise<NeedsInputOutcome> {
	const [run] = await db
		.select({
			userId: chatRuns.userId,
			conversationId: chatRuns.conversationId,
			finishedAt: chatRuns.finishedAt,
			pendingApprovals: chatRuns.pendingApprovals,
			pendingQuestions: chatRuns.pendingQuestions,
		})
		.from(chatRuns)
		.where(eq(chatRuns.id, prompt.runId))
		.limit(1)
	if (!run || run.finishedAt) return 'no_longer_waiting'

	const waiting =
		prompt.kind === 'approval'
			? (run.pendingApprovals ?? []).some((e) => e.token === prompt.token && !e.decision)
			: (run.pendingQuestions ?? []).some((e) => e.token === prompt.token && !e.answers)
	if (!waiting) return 'no_longer_waiting'

	const { notifyUser } = await import('$lib/notifications/notify.server')
	const result = await notifyUser({
		userId: run.userId,
		category: 'needsInput',
		payload: {
			title: prompt.kind === 'approval' ? 'Approval needed' : 'The agent has a question',
			body: prompt.summary.slice(0, 200),
			url: `/chat/${run.conversationId}`,
			// One banner per run: a second prompt in the same turn replaces the first.
			tag: `needs-input:${prompt.runId}`,
		},
	})
	return result.sent ? 'notified' : 'category_off'
}
