/**
 * The chat's answer to the SDK's AskUserQuestion (#4): put the question in front of the user
 * and wait for what they choose.
 *
 * The engine hands a question over from `canUseTool` (`$lib/engine/ask-user-question`); this
 * is the chat run's side of that hand-off, and it does what the old `ask_user` host did:
 *
 *   1. record the question on the run (`chat_runs.pending_questions`) and move the run to
 *      `waiting_user_input`. Recording it is what opens its /review inbox item and schedules
 *      the "needs input" notification, so a user who is not watching the chat can still find
 *      it and answer it there (`$lib/runs/questions.server`);
 *   2. send the `ask_user` frame, which the chat page renders as the question card. The frame
 *      keeps its old name — it means "the agent is asking you", not "this tool ran" — and now
 *      carries the SDK's tool_use id, so the card, the frame and the call's result share one id;
 *   3. wait for the answer, from the card, the composer or /review. The wait is bounded like
 *      an approval's (`QUESTION_TIMEOUT_MS`) and cut short by a stop; after that the model is
 *      told nobody answered. Nothing ever answers on the user's behalf.
 *
 * The store is injectable so a spec can drive the hand-off without a database.
 */

import {
	ASK_USER_QUESTION_TOOL,
	answerKey,
	type AskQuestion,
	type AskUserHost,
} from '$lib/engine/ask-user-question'
import type { PendingQuestionEntry } from '$lib/runs/runs.schema'
import { awaitQuestionAnswers, enqueuePendingQuestion, QUESTION_TIMEOUT_MS } from '$lib/runs/questions.server'
import { markChatRunRunning } from '$lib/runs/run-lifecycle.server'

export type AskUserStore = {
	enqueue: (
		runId: string,
		entry: Omit<PendingQuestionEntry, 'answers' | 'decidedAt'>,
		transition: { state: 'waiting_user_input'; label: string },
	) => Promise<void>
	awaitAnswers: (runId: string, token: string, signal: AbortSignal) => Promise<Record<string, string> | null>
	markRunning: (runId: string) => Promise<void>
}

const databaseStore: AskUserStore = {
	enqueue: (runId, entry, transition) => enqueuePendingQuestion(runId, entry, transition),
	awaitAnswers: (runId, token, signal) => awaitQuestionAnswers(runId, token, QUESTION_TIMEOUT_MS, signal),
	markRunning: (runId) => markChatRunRunning(runId),
}

/**
 * The token an answer has to present. One per question call, so two questions in one turn
 * never share one, and readable in a log next to the approval tokens (`<run>:<tool_use id>`).
 */
export function askUserToken(runId: string, toolUseId: string): string {
	return `${runId}:ask:${toolUseId}`
}

/** A question as it is recorded and sent: keyed, and with "Other" spelled out. */
export function pendingQuestionsFor(questions: AskQuestion[]): AskQuestion[] {
	return questions.map((question) => ({
		...question,
		key: answerKey(question),
		allowFreeformInput: question.allowFreeformInput ?? true,
	}))
}

export function createAskUserHost(input: {
	runId: string
	/** The stream's frame writer — persisted as a run event, so a reconnecting page replays it. */
	emit: (event: string, payload: unknown) => Promise<void>
	store?: AskUserStore
}): AskUserHost {
	const store = input.store ?? databaseStore
	return async ({ toolUseId, questions, signal }) => {
		const token = askUserToken(input.runId, toolUseId)
		const pending = pendingQuestionsFor(questions)

		await store.enqueue(
			input.runId,
			{ token, questions: pending, requestedAt: new Date().toISOString() },
			{ state: 'waiting_user_input', label: 'Waiting for your answer' },
		)
		await input.emit('ask_user', { id: toolUseId, name: ASK_USER_QUESTION_TOOL, token, questions: pending })

		const answers = await store.awaitAnswers(input.runId, token, signal)
		// A stopped run is ending; putting it back to "running" would only flicker.
		if (!signal.aborted) await store.markRunning(input.runId)
		return { answers }
	}
}
