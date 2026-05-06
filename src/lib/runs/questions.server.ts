import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type PendingQuestionEntry } from '$lib/runs/runs.schema'
import { DECISION_TIMEOUT_MS, POLL_INTERVAL_MS } from '$lib/runtime/constants'

export const QUESTION_TIMEOUT_MS = DECISION_TIMEOUT_MS

type EnqueueInput = Omit<PendingQuestionEntry, 'answers' | 'decidedAt'>

type TransitionPatch = {
	state?: (typeof chatRuns.$inferInsert)['state']
	label?: string
}

export async function enqueuePendingQuestion(
	runId: string,
	entry: EnqueueInput,
	transition?: TransitionPatch,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingQuestions: chatRuns.pendingQuestions })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) {
			throw new Error(`enqueuePendingQuestion: run ${runId} not found`)
		}

		const next = [...(row.pendingQuestions ?? []).filter((e) => e.token !== entry.token), entry]
		// Bundle pendingQuestions write + state transition so a crash between can never
		// leave the run in `running` state with an invisible question pending.
		const patch: Partial<typeof chatRuns.$inferInsert> = {
			pendingQuestions: next,
			updatedAt: new Date(),
		}
		if (transition?.state) patch.state = transition.state
		if (transition?.label !== undefined) patch.label = transition.label
		await tx.update(chatRuns).set(patch).where(eq(chatRuns.id, runId))
	})
	// Wave 5 #20 — open a review item so user_question prompts show up in /review even
	// when the SSE client is disconnected. Best-effort + deduped by token.
	void (async () => {
		try {
			const { openReviewItem } = await import('$lib/observability/review.server')
			const firstQ = entry.questions?.[0]
			const summaryFragment = firstQ?.question
				? firstQ.question.slice(0, 120)
				: `${entry.questions?.length ?? 0} question(s)`
			await openReviewItem({
				type: 'user_question',
				severity: 'warning',
				summary: `Agent asked: ${summaryFragment}`,
				payload: { token: entry.token, questions: entry.questions ?? [] },
				runId,
				dedupeKey: `question:${entry.token}`,
			})
		} catch (err) {
			console.warn('[questions] review item open failed (non-fatal)', err)
		}
	})()
}

export async function recordQuestionAnswers(
	runId: string,
	token: string,
	answers: Record<string, string>,
): Promise<{ resolved: boolean }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingQuestions: chatRuns.pendingQuestions })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) return { resolved: false }

		const entries = row.pendingQuestions ?? []
		const idx = entries.findIndex((e) => e.token === token)
		if (idx < 0) return { resolved: false }

		const existing = entries[idx]
		if (existing.answers) return { resolved: false }

		const next = entries.slice()
		next[idx] = {
			...existing,
			answers,
			decidedAt: new Date().toISOString(),
		}
		await tx.update(chatRuns).set({ pendingQuestions: next }).where(eq(chatRuns.id, runId))
		return { resolved: true }
	})
}

async function removePendingQuestion(runId: string, token: string): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingQuestions: chatRuns.pendingQuestions })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) return

		const entries = row.pendingQuestions ?? []
		const next = entries.filter((e) => e.token !== token)
		if (next.length === entries.length) return

		await tx.update(chatRuns).set({ pendingQuestions: next }).where(eq(chatRuns.id, runId))
	})
}

async function readEntry(runId: string, token: string): Promise<PendingQuestionEntry | null> {
	const [row] = await db
		.select({ pendingQuestions: chatRuns.pendingQuestions })
		.from(chatRuns)
		.where(eq(chatRuns.id, runId))
		.limit(1)

	if (!row) return null
	const entry = (row.pendingQuestions ?? []).find((e) => e.token === token)
	return entry ?? null
}

export async function awaitQuestionAnswers(
	runId: string,
	token: string,
	timeoutMs: number = QUESTION_TIMEOUT_MS,
): Promise<Record<string, string> | null> {
	const deadline = Date.now() + timeoutMs

	while (true) {
		const entry = await readEntry(runId, token)

		if (entry?.answers) {
			const answers = entry.answers
			await removePendingQuestion(runId, token)
			return answers
		}

		if (Date.now() >= deadline) {
			await removePendingQuestion(runId, token)
			return null
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}
}
