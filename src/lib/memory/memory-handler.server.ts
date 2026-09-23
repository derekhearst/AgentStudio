import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { releaseDedupeKey } from '$lib/jobs/jobs.server'
import type { JobRow } from '$lib/jobs/jobs.schema'
import { logger } from '$lib/observability/logger'
import { mineConversation, unminedMessagesOf, type MineResult } from './memory.server'

/**
 * Wave 4 #17 phase 5 partial — `memory_mine` job handler.
 *
 * Migrates the previously inline fire-and-forget `void mineConversation(...)` call from the
 * chat-stream handler into a queued job. Benefits:
 *   - Mining survives a process restart (the original fire-and-forget would lose the work).
 *   - Concurrent finishes for the same conversation collapse via dedupeKey `mine:<convId>`.
 *   - Failures are visible in `/settings/jobs` instead of silently swallowed in `console.warn`.
 *   - Cost + retry policy is uniform with other background work.
 *
 * The handler returns the mining result (drawer/wing/room/closet IDs) into `jobs.result` so
 * admins can inspect what landed without going to the activity feed.
 */

const MEMORY_MINE_PAYLOAD = z.object({
	conversationId: z.string().uuid(),
	userIdOverride: z.string().uuid().optional(),
})

/**
 * Most passes one job makes over its conversation. Each pass after the first mines only what
 * arrived during the one before, so a chat would have to finish an exchange during every pass
 * to reach this; past it the job stops and the next exchange's job picks up the rest.
 */
export const MAX_MINE_PASSES = 5

type MineFn = (opts: { conversationId: string; userIdOverride?: string }) => Promise<MineResult>

let registered = false

/**
 * The `memory_mine` handler body, exported so specs can drive one job end to end — with a
 * stand-in for the miner, which would otherwise need a model.
 *
 * A mining job reads the conversation when it starts, then spends seconds in the extractor.
 * An exchange that finishes meanwhile enqueues `mine:<conversationId>`, which folds into this
 * job because it is still running — so its turns must be mined HERE, or they wait for the next
 * exchange, and after a conversation's last exchange they would never be mined automatically.
 * So the job only lets go of its key once the conversation has nothing left to mine, in the
 * same transaction that checks (see `releaseDedupeKey`), and otherwise goes round again.
 */
export async function executeMemoryMineJob(
	job: Pick<JobRow, 'id' | 'dedupeKey' | 'payload'>,
	mine: MineFn = mineConversation,
): Promise<Record<string, unknown>> {
	const parsed = MEMORY_MINE_PAYLOAD.safeParse(job.payload)
	if (!parsed.success) {
		throw new Error(`memory_mine payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
	}
	const { conversationId, userIdOverride } = parsed.data

	const drawerIds: string[] = []
	const wingIds = new Set<string>()
	const roomIds = new Set<string>()
	const closetIds = new Set<string>()
	const excludedByRule = new Set<string>()
	let excludedTurns = 0
	let timedOutTurns = 0
	let extractorFallback = false
	let passes = 0

	for (;;) {
		passes += 1
		const result = await mine({ conversationId, userIdOverride })
		drawerIds.push(...result.drawerIds)
		for (const id of result.wingIds) wingIds.add(id)
		for (const id of result.roomIds) roomIds.add(id)
		for (const id of result.closetIds) closetIds.add(id)
		for (const name of result.excludedByRule) excludedByRule.add(name)
		excludedTurns += result.excludedTurns
		timedOutTurns += result.timedOutTurns
		extractorFallback ||= result.extractorFallback

		// No key, nothing could have folded into this job.
		if (!job.dedupeKey) break
		if (await releaseDedupeKey(job.id, { unlessExists: unminedMessagesOf(conversationId) })) break
		if (passes >= MAX_MINE_PASSES) {
			logger.warn('[memory] mining job stopped with turns still unmined; the next exchange picks them up', {
				conversationId,
				passes,
			})
			break
		}
	}

	return {
		conversationId,
		passes,
		drawerCount: drawerIds.length,
		wingCount: wingIds.size,
		roomCount: roomIds.size,
		closetCount: closetIds.size,
		// Turns the exclusion deny list dropped before embedding — visible in
		// /settings/jobs so a user can tell "nothing was mined" from "a rule fired".
		excludedTurns,
		// Of those, the turns whose check ran out of time: set aside until the rules change.
		timedOutTurns,
		excludedByRule: [...excludedByRule],
		// The extractor failed and the turns were filed with no wing, topic or tags of their
		// own. Mining still "succeeded", so without this nothing says the extractor is broken.
		extractorFallback,
	}
}

export function registerMemoryJobHandlers(): void {
	if (registered) return
	registerJobHandler('memory_mine', ({ job }) => executeMemoryMineJob(job))
	registered = true
}
