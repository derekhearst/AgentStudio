import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
	cleanupPrefixedRecords,
	getActiveAdminUserId,
	getSql,
	seedConversation as seedConversationFull,
	uniquePrefix,
} from './helpers'

/**
 * Stuck-run reaper + manual dismiss. The scheduled tick (`runs_reap.5min`) wraps
 * `reapStuckRuns` — these tests exercise the functions directly to keep them deterministic
 * + parallel-safe.
 */

async function seedConversation(prefix: string, userId: string) {
	const conversation = await seedConversationFull(prefix, { userId, title: `${prefix} convo` })
	const sql = getSql()
	// `seedConversationFull` also writes user + assistant messages we don't need here. Drop
	// them so the test fixture is just an empty conversation row.
	await sql`delete from messages where conversation_id = ${conversation.id}`
	return conversation.id
}

async function seedRun(opts: {
	conversationId: string
	userId: string
	state: 'queued' | 'running' | 'waiting_tool_approval' | 'waiting_user_input' | 'completed' | 'canceled'
	updatedAtMinutesAgo: number
	finishedAt?: Date | null
}) {
	const sql = getSql()
	const updatedAt = new Date(Date.now() - opts.updatedAtMinutesAgo * 60 * 1000)
	const finishedAt = opts.finishedAt === undefined ? null : opts.finishedAt
	const [row] = await sql<{ id: string }[]>`
		insert into chat_runs (
			id, conversation_id, user_id, state, source, label, updated_at, finished_at
		)
		values (
			${randomUUID()},
			${opts.conversationId},
			${opts.userId},
			${opts.state}::chat_run_state,
			'chat_stream',
			'reaper-fixture',
			${updatedAt},
			${finishedAt}
		)
		returning id
	`
	return row.id
}

async function readRun(runId: string) {
	const sql = getSql()
	const [row] = await sql<{
		state: string
		finished_at: Date | null
		error: string | null
		pending_questions: unknown[]
		pending_approvals: unknown[]
	}[]>`
		select
			state::text as state,
			finished_at,
			error,
			pending_questions,
			pending_approvals
		from chat_runs
		where id = ${runId}
		limit 1
	`
	return row
}

test.describe('runs/dismiss — single-run manual cancel', () => {
	test('dismissStuckRun cancels an active run owned by the user', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-dismiss')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			// 5 minutes stale — under reaper threshold but the user still wants to dismiss it.
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'waiting_user_input',
				updatedAtMinutesAgo: 5,
			})

			const { dismissStuckRun } = await import('../src/lib/runs/runs.server')
			const result = await dismissStuckRun(userId, runId)
			expect(result.success).toBe(true)

			const after = await readRun(runId)
			expect(after.state).toBe('canceled')
			expect(after.finished_at).not.toBeNull()
			expect(after.error).toContain('Dismissed')
			expect(after.pending_questions).toEqual([])
			expect(after.pending_approvals).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('dismissStuckRun refuses runs owned by another user', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-dismiss-other')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const ownerId = await getActiveAdminUserId()
		// Username column is unique-constrained; use a per-test random suffix so parallel
		// projects (desktop + mobile) running this test concurrently don't collide.
		const otherUsername = `e2e_other_${randomUUID().slice(0, 12)}`

		try {
			// Seed a second user and assign the run to them.
			const [otherUser] = await sql<{ id: string }[]>`
				insert into users (name, username, role, is_active)
				values (${`${prefix} other`}, ${otherUsername}, 'user', true)
				returning id
			`
			const conversationId = await seedConversation(prefix, otherUser.id)
			const runId = await seedRun({
				conversationId,
				userId: otherUser.id,
				state: 'waiting_user_input',
				updatedAtMinutesAgo: 5,
			})

			const { dismissStuckRun } = await import('../src/lib/runs/runs.server')
			// Calling user is the owner, but the run belongs to otherUser → no-op.
			const result = await dismissStuckRun(ownerId, runId)
			expect(result.success).toBe(false)

			const after = await readRun(runId)
			expect(after.state).toBe('waiting_user_input')
			expect(after.finished_at).toBeNull()
		} finally {
			await sql`delete from chat_runs where user_id in (select id from users where username = ${otherUsername})`
			await sql`delete from conversations where user_id in (select id from users where username = ${otherUsername})`
			await sql`delete from users where username = ${otherUsername}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('dismissStuckRun is idempotent — second call returns success: false', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-dismiss-idem')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'running',
				updatedAtMinutesAgo: 1,
			})

			const { dismissStuckRun } = await import('../src/lib/runs/runs.server')
			const first = await dismissStuckRun(userId, runId)
			expect(first.success).toBe(true)

			const second = await dismissStuckRun(userId, runId)
			expect(second.success).toBe(false)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('runs/reaper — sweeps stuck active runs', () => {
	test('a waiting_user_input run with updatedAt > 1h ago + finishedAt null gets canceled', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-reaper-stuck')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'waiting_user_input',
				updatedAtMinutesAgo: 90, // 1.5h stale
			})

			// Pre-condition: run is still active.
			const before = await readRun(runId)
			expect(before.state).toBe('waiting_user_input')
			expect(before.finished_at).toBeNull()

			const { reapStuckRuns } = await import('../src/lib/runs/runs.server')
			await reapStuckRuns()

			// Post-condition: run is canceled with reason recorded. We assert via the persisted
			// row rather than `result.reapedIds` because parallel test workers running their own
			// reaper calls can race — whichever transaction commits first wins, and the other
			// returns 0 rows. The DB state is what matters.
			const after = await readRun(runId)
			expect(after.state).toBe('canceled')
			expect(after.finished_at).not.toBeNull()
			expect(after.error).toContain('Reaped')
			expect(after.pending_questions).toEqual([])
			expect(after.pending_approvals).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a running run with updatedAt < 1h ago is left alone', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-reaper-fresh')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'running',
				updatedAtMinutesAgo: 10, // well under threshold
			})

			const { reapStuckRuns } = await import('../src/lib/runs/runs.server')
			const result = await reapStuckRuns()

			expect(result.reapedIds).not.toContain(runId)

			const after = await readRun(runId)
			expect(after.state).toBe('running')
			expect(after.finished_at).toBeNull()
			expect(after.error).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a completed run (already finished) is skipped even if updatedAt is ancient', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-reaper-done')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			const finishedAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'completed',
				updatedAtMinutesAgo: 60 * 24, // 24h stale
				finishedAt,
			})

			const { reapStuckRuns } = await import('../src/lib/runs/runs.server')
			const result = await reapStuckRuns()

			expect(result.reapedIds).not.toContain(runId)

			const after = await readRun(runId)
			expect(after.state).toBe('completed')
			expect(after.finished_at).not.toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('threshold override — a 30-minute-old waiting_tool_approval run is reaped with a 15-minute threshold', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-reaper-threshold')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'waiting_tool_approval',
				updatedAtMinutesAgo: 30,
			})

			const { reapStuckRuns } = await import('../src/lib/runs/runs.server')
			await reapStuckRuns({ thresholdMs: 15 * 60 * 1000 })

			const after = await readRun(runId)
			expect(after.state).toBe('canceled')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the same run is not reaped twice across consecutive ticks (idempotent)', async () => {
		test.setTimeout(15_000)
		const prefix = uniquePrefix('runs-reaper-idem')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveAdminUserId()

		try {
			const conversationId = await seedConversation(prefix, userId)
			const runId = await seedRun({
				conversationId,
				userId,
				state: 'waiting_user_input',
				updatedAtMinutesAgo: 120,
			})

			const { reapStuckRuns } = await import('../src/lib/runs/runs.server')
			await reapStuckRuns()

			// First tick should have canceled the run.
			const afterFirst = await readRun(runId)
			expect(afterFirst.state).toBe('canceled')
			const firstFinishedAt = afterFirst.finished_at

			// Second tick should NOT touch the row again (finishedAt now non-null filters it
			// out of the WHERE clause).
			const second = await reapStuckRuns()
			expect(second.reapedIds).not.toContain(runId)

			// And finished_at should not have moved (the row wasn't re-updated).
			const afterSecond = await readRun(runId)
			expect(afterSecond.finished_at?.toISOString()).toBe(firstFinishedAt?.toISOString())
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
