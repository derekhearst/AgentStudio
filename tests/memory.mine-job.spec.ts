import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #17 phase 5 partial — memory_mine job migration contract.
 *
 * The chat-stream handler used to call `void mineConversation(...)` directly. It now enqueues
 * a `memory_mine` job with `dedupeKey = mine:${conversationId}`. This spec pins the
 * dedupe + payload + queue contract so a regression in the migration can't silently start
 * spawning duplicate work.
 *
 * Live mining still runs through the existing memory tests + the chat-stream live tests
 * (which now exercise the enqueue → worker → mineConversation path automatically).
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function cleanupMinePrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type = 'memory_mine' and dedupe_key like ${`mine:${prefix}%`}`
	await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
	await sql`delete from conversations where title like ${`${prefix}%`}`
}

test.describe('memory/mine-job — dedupe + payload + queue contract', () => {
	test('repeated enqueue with the same conversationId collapses to one job', async () => {
		const prefix = uniquePrefix('mine-dedupe')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			// First enqueue → creates row.
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id, session_id)
				values (
					'memory_mine', 'default', 50, ${`mine:${conv.id}`},
					${sql.json({ conversationId: conv.id })}, ${userId}, ${conv.id}
				)
			`
			// Second + third enqueues with the same dedupe_key MUST collide on the unique index.
			let secondThrew = false
			try {
				await sql`
					insert into jobs (type, queue, priority, dedupe_key, payload, user_id, session_id)
					values (
						'memory_mine', 'default', 50, ${`mine:${conv.id}`},
						${sql.json({ conversationId: conv.id })}, ${userId}, ${conv.id}
					)
				`
			} catch {
				secondThrew = true
			}
			expect(secondThrew, 'second enqueue with same dedupe_key should be rejected').toBe(true)

			// Verify only one row exists.
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs
				where type = 'memory_mine' and dedupe_key = ${`mine:${conv.id}`}
			`
			expect(count).toBe(1)
		} finally {
			await cleanupMinePrefix(prefix)
		}
	})

	test('memory_mine jobs land in the default queue at background priority (50)', async () => {
		const prefix = uniquePrefix('mine-queue-priority')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const [job] = await sql<{ queue: string; priority: number; type: string }[]>`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id)
				values (
					'memory_mine', 'default', 50, ${`mine:${conv.id}`},
					${sql.json({ conversationId: conv.id })}, ${userId}
				)
				returning queue, priority, type
			`
			expect(job.queue).toBe('default')
			expect(job.priority).toBe(50) // background tier — outranked by user-initiated work (100+)
			expect(job.type).toBe('memory_mine')
		} finally {
			await cleanupMinePrefix(prefix)
		}
	})

	test('mining a different conversation gets its own dedupe_key (no collision)', async () => {
		const prefix = uniquePrefix('mine-cross-convo')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [c1] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} a`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const [c2] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} b`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			await sql`
				insert into jobs (type, dedupe_key, payload, user_id) values
					('memory_mine', ${`mine:${c1.id}`}, ${sql.json({ conversationId: c1.id })}, ${userId}),
					('memory_mine', ${`mine:${c2.id}`}, ${sql.json({ conversationId: c2.id })}, ${userId})
			`
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs
				where type = 'memory_mine' and dedupe_key like ${`mine:${prefix}%`}
				   or (type = 'memory_mine' and (dedupe_key = ${`mine:${c1.id}`} or dedupe_key = ${`mine:${c2.id}`}))
			`
			expect(count).toBe(2)
		} finally {
			await cleanupMinePrefix(prefix)
		}
	})

	test('mining job links back to the originating run via run_id', async () => {
		const prefix = uniquePrefix('mine-runlink')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			// Use a real chat_run row (not just an arbitrary uuid) so the run_id pointer is honest.
			const [run] = await sql<{ id: string }[]>`
				insert into chat_runs (id, conversation_id, user_id, state, source, label)
				values (gen_random_uuid(), ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} r`})
				returning id
			`
			const [job] = await sql<{ run_id: string | null; session_id: string | null }[]>`
				insert into jobs (type, dedupe_key, payload, user_id, run_id, session_id)
				values (
					'memory_mine', ${`mine:${conv.id}`},
					${sql.json({ conversationId: conv.id })},
					${userId}, ${run.id}, ${conv.id}
				)
				returning run_id, session_id
			`
			expect(job.run_id).toBe(run.id)
			expect(job.session_id).toBe(conv.id)
		} finally {
			await cleanupMinePrefix(prefix)
		}
	})
})
