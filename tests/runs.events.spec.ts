import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

type EventRow = {
	id: string
	run_id: string
	seq: number
	type: string
	payload: unknown
	created_at: Date
}

async function seedRun(prefix: string) {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users
		where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found for seeding')

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} Conversation`}, ${user.id}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label)
		values (${conversation.id}, ${user.id}, 'running', 'chat_stream', ${`${prefix} run`})
		returning id
	`
	return { userId: user.id, conversationId: conversation.id, runId: run.id }
}

async function listEvents(runId: string): Promise<EventRow[]> {
	const sql = getSql()
	return sql<EventRow[]>`
		select id, run_id, seq, type, payload, created_at
		from run_events
		where run_id = ${runId}
		order by seq asc
	`
}

async function readNextEventSeq(runId: string): Promise<number> {
	const sql = getSql()
	const [row] = await sql<{ next_event_seq: number }[]>`
		select next_event_seq from chat_runs where id = ${runId}
	`
	return row.next_event_seq
}

test.describe('runs/events — append-only event log', () => {
	test('newly seeded run starts at next_event_seq = 0 with no events', async () => {
		const prefix = uniquePrefix('runs-events-default')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		try {
			expect(await readNextEventSeq(seeded.runId)).toBe(0)
			expect(await listEvents(seeded.runId)).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('inserting events through the counter yields gapless seq starting at 1', async () => {
		const prefix = uniquePrefix('runs-events-gapless')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		const sql = getSql()
		try {
			for (const [type, payload] of [
				['compaction', { tokensBefore: 12000 }],
				['tool_call', { id: 'call_1', name: 'shell' }],
				['tool_result', { id: 'call_1', success: true }],
				['done', { messageId: 'msg_1' }],
			] as const) {
				const [{ seq }] = await sql<{ seq: number }[]>`
					update chat_runs
					set next_event_seq = next_event_seq + 1
					where id = ${seeded.runId}
					returning next_event_seq as seq
				`
				await sql`
					insert into run_events (run_id, seq, type, payload)
					values (${seeded.runId}, ${seq}, ${type}, ${sql.json(payload)})
				`
			}

			const events = await listEvents(seeded.runId)
			expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
			expect(events.map((e) => e.type)).toEqual(['compaction', 'tool_call', 'tool_result', 'done'])
			expect(await readNextEventSeq(seeded.runId)).toBe(4)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('events cascade on run deletion', async () => {
		const prefix = uniquePrefix('runs-events-cascade')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		const sql = getSql()
		try {
			const [{ seq }] = await sql<{ seq: number }[]>`
				update chat_runs set next_event_seq = next_event_seq + 1 where id = ${seeded.runId} returning next_event_seq as seq
			`
			await sql`
				insert into run_events (run_id, seq, type, payload)
				values (${seeded.runId}, ${seq}, 'tool_call', ${sql.json({ id: 'x' })})
			`
			expect(await listEvents(seeded.runId)).toHaveLength(1)

			await sql`delete from chat_runs where id = ${seeded.runId}`
			expect(await listEvents(seeded.runId)).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
