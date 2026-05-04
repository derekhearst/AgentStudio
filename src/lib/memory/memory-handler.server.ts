import { z } from 'zod'
import { registerJobHandler } from '$lib/jobs/worker.server'
import { mineConversation } from './memory.server'

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

let registered = false

export function registerMemoryJobHandlers(): void {
	if (registered) return
	registerJobHandler('memory_mine', async ({ job }) => {
		const parsed = MEMORY_MINE_PAYLOAD.safeParse(job.payload)
		if (!parsed.success) {
			throw new Error(`memory_mine payload missing/invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
		}
		const result = await mineConversation({
			conversationId: parsed.data.conversationId,
			userIdOverride: parsed.data.userIdOverride,
		})
		return {
			conversationId: parsed.data.conversationId,
			drawerCount: result.drawerIds.length,
			wingCount: result.wingIds.length,
			roomCount: result.roomIds.length,
			closetCount: result.closetIds.length,
		}
	})
	registered = true
}
