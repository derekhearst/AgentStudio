import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type PendingApprovalEntry } from '$lib/runs/runs.schema'

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 500

type EnqueueInput = Omit<PendingApprovalEntry, 'decision' | 'decidedAt'>

export async function enqueuePendingApproval(runId: string, entry: EnqueueInput): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ pendingApprovals: chatRuns.pendingApprovals })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.for('update')

		if (!row) {
			throw new Error(`enqueuePendingApproval: run ${runId} not found`)
		}

		const next = [...(row.pendingApprovals ?? []).filter((e) => e.token !== entry.token), entry]
		await tx.update(chatRuns).set({ pendingApprovals: next }).where(eq(chatRuns.id, runId))
	})
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
