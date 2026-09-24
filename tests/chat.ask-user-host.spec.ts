import { expect, test } from '@playwright/test'
import { askUserToken, createAskUserHost, pendingQuestionsFor, type AskUserStore } from '../src/lib/chat/ask-user-host.server'
import { readAskQuestions } from '../src/lib/engine/ask-user-question'

/**
 * The chat run's side of AskUserQuestion (#4): record the question, show it, wait.
 *
 * Recording it on the run (`chat_runs.pending_questions`) is what opens its /review inbox item
 * and schedules the "needs input" push, so a question asked while nobody watches the chat
 * waits there to be answered, as the old `ask_user` did. The store is injected, so no
 * database is touched.
 */

const QUESTIONS = readAskQuestions({
	questions: [
		{
			question: 'Which features?',
			header: 'Features',
			multiSelect: true,
			options: [
				{ label: 'Search', description: 's', preview: '<b>search</b>' },
				{ label: 'Export', description: 'e' },
			],
		},
	],
})

function recordingStore(answers: Record<string, string> | null) {
	const calls: Array<{ op: string; args: unknown[] }> = []
	const store: AskUserStore = {
		enqueue: async (...args) => {
			calls.push({ op: 'enqueue', args })
		},
		awaitAnswers: async (...args) => {
			calls.push({ op: 'awaitAnswers', args })
			return answers
		},
		markRunning: async (...args) => {
			calls.push({ op: 'markRunning', args })
		},
	}
	return { store, calls }
}

test('records the question, then shows it, then waits — and puts the run back to running', async () => {
	const { store, calls } = recordingStore({ 'Which features?': 'Search' })
	const frames: Array<{ event: string; payload: unknown }> = []
	const host = createAskUserHost({
		runId: 'run-1',
		store,
		emit: async (event, payload) => {
			calls.push({ op: `emit:${event}`, args: [] })
			frames.push({ event, payload })
		},
	})
	const signal = new AbortController().signal
	const reply = await host({ toolUseId: 'toolu_9', questions: QUESTIONS, signal })

	expect(reply).toEqual({ answers: { 'Which features?': 'Search' } })
	// Recorded before the frame: an answer racing the card must find the pending row.
	expect(calls.map((c) => c.op)).toEqual(['enqueue', 'emit:ask_user', 'awaitAnswers', 'markRunning'])

	const token = askUserToken('run-1', 'toolu_9')
	expect(token).toBe('run-1:ask:toolu_9')
	const [runId, entry, transition] = calls[0].args as [string, { token: string; questions: unknown[] }, unknown]
	expect(runId).toBe('run-1')
	expect(entry.token).toBe(token)
	// The /review item and the reloaded page read these: previews, multi-select and the key survive.
	expect(entry.questions).toEqual(pendingQuestionsFor(QUESTIONS))
	expect(entry.questions[0]).toMatchObject({
		key: 'Which features?',
		multiSelect: true,
		allowFreeformInput: true,
		options: [{ label: 'Search', preview: '<b>search</b>' }, { label: 'Export' }],
	})
	expect(transition).toEqual({ state: 'waiting_user_input', label: 'Waiting for your answer' })

	// The frame carries the SDK's tool_use id, so the card, the frame and the result share one id.
	expect(frames).toEqual([
		{ event: 'ask_user', payload: { id: 'toolu_9', name: 'AskUserQuestion', token, questions: entry.questions } },
	])
	expect(calls[2].args).toEqual(['run-1', token, signal])
})

test('nobody answered: null goes back, and the engine tells the model so', async () => {
	const { store } = recordingStore(null)
	const host = createAskUserHost({ runId: 'run-1', store, emit: async () => {} })
	expect(await host({ toolUseId: 't', questions: QUESTIONS, signal: new AbortController().signal })).toEqual({ answers: null })
})

test('a stopped run is not put back to running', async () => {
	const { store, calls } = recordingStore(null)
	const host = createAskUserHost({ runId: 'run-1', store, emit: async () => {} })
	await host({ toolUseId: 't', questions: QUESTIONS, signal: AbortSignal.abort() })
	expect(calls.map((c) => c.op)).not.toContain('markRunning')
})
