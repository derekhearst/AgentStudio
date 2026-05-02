import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns, type StreamBlock } from '$lib/runs/runs.schema'

export async function persistRunBlocks(runId: string, blocks: StreamBlock[]): Promise<void> {
	await db.update(chatRuns).set({ streamBlocks: blocks }).where(eq(chatRuns.id, runId))
}

export async function setRunRound(runId: string, round: number): Promise<void> {
	await db.update(chatRuns).set({ currentRound: round }).where(eq(chatRuns.id, runId))
}
