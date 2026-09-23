import { and, eq, inArray, sql } from 'drizzle-orm'
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

/** Run states an approval answer can still land in. */
const RESOLVABLE_STATES = ['running', 'waiting_tool_approval'] as const

/**
 * How long an operator's answer waits for the approval it answers to be recorded.
 *
 * The card with the Allow and Deny buttons goes out on the call's `tool_pending` frame, from
 * the engine's assistant branch. The approval itself is recorded a moment later, when the SDK
 * reaches `canUseTool` and `requestApproval` enqueues it. An answer that arrived inside that
 * gap found no token, got `resolved: false`, and the call then waited out its timeout and was
 * recorded as the user's denial. Normally the gap is milliseconds.
 */
export const APPROVAL_TOKEN_WAIT_MS = 3_000
const APPROVAL_TOKEN_POLL_MS = 100

/**
 * The live run in a conversation, owned by `userId`, that has `token` pending — waiting up to
 * `waitMs` for it to appear. Null when none does.
 */
export async function findRunAwaitingApproval(input: {
	conversationId: string
	userId: string
	token: string
	waitMs?: number
}): Promise<string | null> {
	const tokenJson = JSON.stringify([{ token: input.token }])
	const deadline = Date.now() + (input.waitMs ?? APPROVAL_TOKEN_WAIT_MS)
	while (true) {
		const [run] = await db
			.select({ id: chatRuns.id })
			.from(chatRuns)
			.where(
				and(
					eq(chatRuns.conversationId, input.conversationId),
					eq(chatRuns.userId, input.userId),
					inArray(chatRuns.state, RESOLVABLE_STATES),
					sql`${chatRuns.pendingApprovals} @> ${tokenJson}::jsonb`,
				),
			)
			.limit(1)
		if (run) return run.id
		if (Date.now() >= deadline) return null
		await new Promise((resolve) => setTimeout(resolve, APPROVAL_TOKEN_POLL_MS))
	}
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
