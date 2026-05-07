import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type PendingApprovalEntry } from '$lib/runs/runs.schema'
import { DECISION_TIMEOUT_MS, POLL_INTERVAL_MS } from '$lib/runtime/constants'
import { logger } from '$lib/observability/logger'

export const APPROVAL_TIMEOUT_MS = DECISION_TIMEOUT_MS

type EnqueueInput = Omit<PendingApprovalEntry, 'decision' | 'decidedAt'>

type TransitionPatch = {
	state?: (typeof chatRuns.$inferInsert)['state']
	label?: string
}

export async function enqueuePendingApproval(
	runId: string,
	entry: EnqueueInput,
	transition?: TransitionPatch,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingApprovals: chatRuns.pendingApprovals, conversationId: chatRuns.conversationId })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) {
			throw new Error(`enqueuePendingApproval: run ${runId} not found`)
		}

		const next = [...(row.pendingApprovals ?? []).filter((e) => e.token !== entry.token), entry]
		// Bundle the pendingApprovals write with the state transition so we never end up
		// with the run in `running` state while pendingApprovals already has the entry
		// (or vice versa) on a crash between the two writes.
		const patch: Partial<typeof chatRuns.$inferInsert> = {
			pendingApprovals: next,
			updatedAt: new Date(),
		}
		if (transition?.state) patch.state = transition.state
		if (transition?.label !== undefined) patch.label = transition.label
		await tx.update(chatRuns).set(patch).where(eq(chatRuns.id, runId))
	})
	// Wave 5 #20 — open a review item so approval requests show up in /review even when the
	// SSE client is disconnected. Best-effort + deduped by token so retries collapse.
	void (async () => {
		try {
			const { openReviewItem } = await import('$lib/observability/review.server')
			await openReviewItem({
				type: 'approval_request',
				severity: 'warning',
				summary: `Tool approval requested: ${entry.toolName}`,
				payload: { toolName: entry.toolName, args: entry.args, token: entry.token },
				runId,
				dedupeKey: `approval:${entry.token}`,
			})
		} catch (err) {
			logger.warn('[approvals] review item open failed (non-fatal)', { err })
		}
	})()
}

export async function recordApprovalDecision(
	runId: string,
	token: string,
	approved: boolean,
): Promise<{ resolved: boolean }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingApprovals: chatRuns.pendingApprovals })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) return { resolved: false }

		const entries = row.pendingApprovals ?? []
		const idx = entries.findIndex((e) => e.token === token)
		if (idx < 0) return { resolved: false }

		const existing = entries[idx]
		if (existing.decision) return { resolved: false }

		const next = entries.slice()
		next[idx] = {
			...existing,
			decision: approved ? 'approved' : 'denied',
			decidedAt: new Date().toISOString(),
		}
		await tx.update(chatRuns).set({ pendingApprovals: next }).where(eq(chatRuns.id, runId))
		return { resolved: true }
	})
}

async function removePendingApproval(runId: string, token: string): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingApprovals: chatRuns.pendingApprovals })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) return

		const entries = row.pendingApprovals ?? []
		const next = entries.filter((e) => e.token !== token)
		if (next.length === entries.length) return

		await tx.update(chatRuns).set({ pendingApprovals: next }).where(eq(chatRuns.id, runId))
	})
}

async function readDecision(runId: string, token: string): Promise<PendingApprovalEntry | null> {
	const [row] = await db
		.select({ pendingApprovals: chatRuns.pendingApprovals })
		.from(chatRuns)
		.where(eq(chatRuns.id, runId))
		.limit(1)

	if (!row) return null
	const entry = (row.pendingApprovals ?? []).find((e) => e.token === token)
	return entry ?? null
}

export async function awaitApprovalDecision(
	runId: string,
	token: string,
	timeoutMs: number = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs

	while (true) {
		const entry = await readDecision(runId, token)

		if (entry?.decision) {
			const approved = entry.decision === 'approved'
			await removePendingApproval(runId, token)
			return approved
		}

		if (Date.now() >= deadline) {
			await removePendingApproval(runId, token)
			return false
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}
}
