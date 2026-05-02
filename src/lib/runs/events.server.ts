import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, runEvents, type RunEventPayload } from '$lib/runs/runs.schema'

export type RunEventRow = {
	id: string
	runId: string
	seq: number
	type: string
	payload: RunEventPayload
	createdAt: Date
}

export async function appendRunEvent(runId: string, type: string, payload: RunEventPayload): Promise<number> {
	return db.transaction(async (tx) => {
		const [counter] = await tx
			.update(chatRuns)
			.set({ nextEventSeq: sql`${chatRuns.nextEventSeq} + 1` })
			.where(eq(chatRuns.id, runId))
			.returning({ seq: chatRuns.nextEventSeq })

		if (!counter) {
			throw new Error(`appendRunEvent: run ${runId} not found`)
		}

		await tx.insert(runEvents).values({
			runId,
			seq: counter.seq,
			type,
			payload,
		})

		return counter.seq
	})
}

export async function listRunEvents(runId: string, sinceSeq = 0): Promise<RunEventRow[]> {
	return db
		.select()
		.from(runEvents)
		.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, sinceSeq)))
		.orderBy(asc(runEvents.seq))
}
