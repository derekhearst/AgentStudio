import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedConversation,
	uniquePrefix,
} from './helpers'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { claimRun, interruptRun, registerRunHandle, type EngineQueryHandle } from '../src/lib/engine/run-registry.server'

/**
 * A live chat run's own writes to its row, and how it is stopped.
 *
 *   - The heartbeat (#105 / #86 / #130). The engine path never touched `chat_runs.updated_at`
 *     after the insert, so the stuck-run reaper — which cancels and interrupts anything
 *     active whose `updated_at` is over an hour old — cut every turn longer than an hour
 *     short, mid-work. The run's frames now keep the row fresh.
 *   - The final write. It used to overwrite a run the reaper or a dismiss had already
 *     canceled, turning it back into "completed".
 *   - Stop (#129). A dropped connection used to interrupt the run, which contradicted the
 *     resume contract; Stop is now its own request, reaching the run through the registry.
 *   - One turn at a time (#129). Once a turn outlived a reload, a second message could start
 *     a second CLI on the same SDK session; the stream now refuses one while a turn is live,
 *     and a reloaded page re-attaches to the live turn instead.
 */

async function seedRun(
	conversationId: string,
	opts: { minutesAgo?: number; finished?: boolean; source?: 'chat_stream' | 'automation' } = {},
) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const at = new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000)
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, started_at, updated_at, finished_at)
		values (
			${conversationId},
			${userId},
			${opts.finished ? 'completed' : 'running'},
			${opts.source ?? 'chat_stream'},
			${at},
			${at},
			${opts.finished ? sql`now()` : null}
		)
		returning id
	`
	return run.id
}

async function readRun(runId: string) {
	const sql = getSql()
	const [row] = await sql<{ state: string; updated_at: Date; last_heartbeat_at: Date | null; finished_at: Date | null; error: string | null }[]>`
		select state::text as state, updated_at, last_heartbeat_at, finished_at, error from chat_runs where id = ${runId}
	`
	return row
}

function fakeHandle(onInterrupt: () => void): EngineQueryHandle {
	return {
		interrupt: async () => onInterrupt(),
		stopTask: async () => {},
		getContextUsage: async () => null,
	}
}

test.describe('runs/heartbeat — the throttle', () => {
	test('writes once per interval, however many frames arrive', async () => {
		const { createRunHeartbeat } = await import('../src/lib/runs/run-lifecycle.server')
		let clock = 0
		const writes: number[] = []
		const heartbeat = createRunHeartbeat('run-x', {
			intervalMs: 30_000,
			now: () => clock,
			write: async (_runId, at) => {
				writes.push(at.getTime())
			},
		})

		// The insert just wrote the row, so the first frames write nothing.
		for (clock = 0; clock < 30_000; clock += 1_000) heartbeat.beat()
		expect(writes).toEqual([])

		clock = 30_000
		heartbeat.beat()
		clock = 45_000
		heartbeat.beat()
		clock = 61_000
		heartbeat.beat()
		expect(writes).toEqual([30_000, 61_000])
	})

	test('a failed write never reaches the caller', async () => {
		const { createRunHeartbeat } = await import('../src/lib/runs/run-lifecycle.server')
		let clock = 0
		const heartbeat = createRunHeartbeat('run-x', {
			intervalMs: 10,
			now: () => clock,
			write: async () => {
				throw new Error('db down')
			},
		})
		clock = 20
		expect(() => heartbeat.beat()).not.toThrow()
	})
})

test.describe('runs/heartbeat — against the reaper', () => {
	test('a run that keeps beating is not reaped however long it has been going', async () => {
		test.setTimeout(20_000)
		const prefix = uniquePrefix('runs-heartbeat')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			// Started 90 minutes ago; its row has not been touched since.
			const runId = await seedRun(conv.id, { minutesAgo: 90 })

			// What the throttle calls once per interval while the run's frames flow.
			const { touchChatRun } = await import('../src/lib/runs/run-lifecycle.server')
			await touchChatRun(runId)

			const touched = await readRun(runId)
			expect(Date.now() - touched.updated_at.getTime()).toBeLessThan(60_000)
			expect(touched.last_heartbeat_at).not.toBeNull()

			const { reapStuckRuns } = await import('../src/lib/runs/runs.server')
			await reapStuckRuns()

			const after = await readRun(runId)
			expect(after.state).toBe('running')
			expect(after.finished_at).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a heartbeat does not touch a run that has already ended', async () => {
		const prefix = uniquePrefix('runs-heartbeat-ended')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id, { minutesAgo: 90, finished: true })
			const before = (await readRun(runId)).updated_at.getTime()

			const { touchChatRun } = await import('../src/lib/runs/run-lifecycle.server')
			await touchChatRun(runId)
			expect((await readRun(runId)).updated_at.getTime()).toBe(before)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('runs/finish — a run something else ended stays ended', () => {
	test('the final write does not resurrect a dismissed run', async () => {
		const prefix = uniquePrefix('runs-finish-dismissed')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)

			const { dismissStuckRun } = await import('../src/lib/runs/runs.server')
			expect((await dismissStuckRun(userId, runId)).success).toBe(true)

			const { finishChatRun, markChatRunRunning } = await import('../src/lib/runs/run-lifecycle.server')
			await markChatRunRunning(runId)
			const applied = await finishChatRun(runId, { state: 'completed', label: 'Completed', error: null })
			expect(applied).toBe(false)

			const after = await readRun(runId)
			expect(after.state).toBe('canceled')
			expect(after.error).toContain('Dismissed')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a live run is finished normally', async () => {
		const prefix = uniquePrefix('runs-finish-live')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)

			const { finishChatRun } = await import('../src/lib/runs/run-lifecycle.server')
			expect(await finishChatRun(runId, { state: 'failed', label: 'Failed', error: 'boom' })).toBe(true)

			const after = await readRun(runId)
			expect(after.state).toBe('failed')
			expect(after.error).toBe('boom')
			expect(after.finished_at).not.toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('runs/stop — Stop is a request, not a dropped connection', () => {
	test('stops the owner\'s live run through the registry, and leaves the row to the run', async () => {
		const prefix = uniquePrefix('runs-stop-live')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)
			let interrupted = 0
			const release = registerRunHandle(runId, fakeHandle(() => interrupted++))

			try {
				const { stopChatRun } = await import('../src/lib/runs/runs.server')
				expect(await stopChatRun({ userId, conversationId: conv.id, runId })).toEqual({ stopped: true })
				expect(interrupted).toBe(1)
				// The interrupted turn ends with an ordinary result and writes its own ending.
				expect((await readRun(runId)).state).toBe('running')
			} finally {
				release()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('without a run id, Stop reaches whatever is live in the conversation', async () => {
		const prefix = uniquePrefix('runs-stop-any')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)
			let interrupted = 0
			const release = registerRunHandle(runId, fakeHandle(() => interrupted++))
			try {
				const { stopChatRun } = await import('../src/lib/runs/runs.server')
				expect(await stopChatRun({ userId, conversationId: conv.id })).toEqual({ stopped: true })
				expect(interrupted).toBe(1)
			} finally {
				release()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a stranger, a finished run and a run held elsewhere are all refused', async () => {
		const prefix = uniquePrefix('runs-stop-refused')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const liveId = await seedRun(conv.id)
			const finishedId = await seedRun(conv.id, { finished: true })
			let interrupted = 0
			const release = registerRunHandle(liveId, fakeHandle(() => interrupted++))
			const releaseFinished = registerRunHandle(finishedId, fakeHandle(() => interrupted++))

			try {
				const { stopChatRun } = await import('../src/lib/runs/runs.server')
				// Ownership is the query, not the registry: the handle is right there.
				expect(await stopChatRun({ userId: randomUUID(), conversationId: conv.id, runId: liveId })).toEqual({
					stopped: false,
					reason: 'run_not_active',
				})
				expect(await stopChatRun({ userId, conversationId: conv.id, runId: finishedId })).toEqual({
					stopped: false,
					reason: 'run_not_active',
				})
				expect(interrupted).toBe(0)
			} finally {
				release()
				releaseFinished()
			}

			const { stopChatRun } = await import('../src/lib/runs/runs.server')
			expect(await stopChatRun({ userId, conversationId: conv.id, runId: liveId })).toEqual({
				stopped: false,
				reason: 'not_reachable',
			})
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the endpoint answers for a run no session in the server holds', async ({ page }) => {
		const prefix = uniquePrefix('runs-stop-endpoint')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)

			const live = await page.request.post(`/chat/${conv.id}/stop`, { data: { runId } })
			expect(live.status()).toBe(200)
			expect(await live.json()).toEqual({ stopped: false, reason: 'not_reachable' })

			const malformed = await page.request.post(`/chat/${conv.id}/stop`, { data: { runId: 'nope' } })
			expect(malformed.status()).toBe(400)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('runs/one turn at a time — a live turn blocks a second, an abandoned one does not', () => {
	test('a turn this process is running blocks the next, and is what a reloaded page attaches to', async () => {
		const prefix = uniquePrefix('runs-turn-live')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id)
			const release = claimRun(runId)
			try {
				const { findLiveChatRun, turnInProgress } = await import('../src/lib/runs/live-chat-run.server')
				expect(await turnInProgress(conv.id, userId)).toBe(runId)
				expect(await findLiveChatRun(conv.id, userId)).toBe(runId)
				// Someone else's conversation view never sees it.
				expect(await findLiveChatRun(conv.id, randomUUID())).toBeNull()
				expect((await readRun(runId)).state).toBe('running')
			} finally {
				release()
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("an open turn nothing is running — a restart's leftover — is canceled, not waited out", async () => {
		const prefix = uniquePrefix('runs-turn-abandoned')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const abandoned = await seedRun(conv.id, { minutesAgo: 10 })
			// Automation runs execute in the jobs worker; this process holds no claim on them.
			const automation = await seedRun(conv.id, { source: 'automation' })

			const { findLiveChatRun, turnInProgress, ABANDONED_RUN_REASON } = await import(
				'../src/lib/runs/live-chat-run.server'
			)
			// The page's read leaves it alone, and does not offer it to attach to.
			expect(await findLiveChatRun(conv.id, userId)).toBeNull()
			expect((await readRun(abandoned)).state).toBe('running')

			// A new turn clears it and goes ahead.
			expect(await turnInProgress(conv.id, userId)).toBeNull()
			const after = await readRun(abandoned)
			expect(after.state).toBe('canceled')
			expect(after.finished_at).not.toBeNull()
			expect(after.error).toBe(ABANDONED_RUN_REASON)
			expect((await readRun(automation)).state).toBe('running')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('runs/registry — a Stop that arrives before the session exists', () => {
	test('is kept on the claim and applied when the handle is published', async () => {
		const runId = randomUUID()
		const releaseClaim = claimRun(runId)
		try {
			// Still preparing its workspace: no handle yet, but it is this process's run.
			expect(await interruptRun(runId, 'Stopped by the user')).toBe(true)
			let interrupted = 0
			const release = registerRunHandle(runId, fakeHandle(() => interrupted++))
			await expect.poll(() => interrupted).toBe(1)
			release()
		} finally {
			releaseClaim()
		}
		// Released: nothing here is running it any more.
		expect(await interruptRun(runId, 'Stopped by the user')).toBe(false)
	})
})

test.describe('chat stream route — the server half of #129', () => {
	/*
	 * Read as source: the route's POST runs a real engine. What each piece does is pinned
	 * above; this pins that the route uses them the way the contract says.
	 */
	const source = readFileSync(resolve('src/routes/chat/[id]/stream/+server.ts'), 'utf8')

	test('a dropped connection does not interrupt the run', () => {
		const cancel = /\n\t\tcancel\(\)\s*\{([\s\S]*?)\n\t\t\},/.exec(source)
		expect(cancel, 'the stream has a cancel handler').not.toBeNull()
		expect(cancel![1]).toContain('clientGone = true')
		expect(cancel![1]).not.toMatch(/interrupt|abort|releaseRunHandle/)
	})

	test('a send while a turn is live is refused before anything is written', () => {
		const check = source.indexOf('await turnInProgress(')
		expect(check).toBeGreaterThan(-1)
		expect(source).toMatch(/status:\s*409/)
		// Before the user's message is saved and before the run row exists.
		expect(check).toBeLessThan(source.indexOf('resolveParentMessage('))
		expect(check).toBeLessThan(source.indexOf('.insert(chatRuns)'))
	})

	test('the run is claimed as soon as its row exists, and released on every way out', () => {
		expect(source.indexOf('claimRun(run.id)')).toBeGreaterThan(source.indexOf('.insert(chatRuns)'))
		// Workspace failure, options failure, a setup step that throws, and the turn's own end.
		expect(source.match(/releaseClaim\(\)/g)?.length).toBeGreaterThanOrEqual(4)
		// A failed start is a finished run, not an open one the page would wait on.
		expect(source).not.toMatch(/set\(\{\s*state:\s*'failed'/)
	})
})
