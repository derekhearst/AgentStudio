import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

async function seedRunWithEvents(
	prefix: string,
	opts: { state: string; events: Array<{ type: string; payload: Record<string, unknown> }> },
) {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users
		where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} Conversation`}, ${user.id}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label, finished_at)
		values (
			${conversation.id},
			${user.id},
			${opts.state}::chat_run_state,
			'chat_stream',
			${`${prefix} run`},
			${opts.state === 'completed' || opts.state === 'failed' || opts.state === 'canceled' ? new Date() : null}
		)
		returning id
	`

	for (const ev of opts.events) {
		const [{ seq }] = await sql<{ seq: number }[]>`
			update chat_runs set next_event_seq = next_event_seq + 1
			where id = ${run.id}
			returning next_event_seq as seq
		`
		await sql`
			insert into run_events (run_id, seq, type, payload)
			values (${run.id}, ${seq}, ${ev.type}, ${sql.json(ev.payload as never)})
		`
	}

	return { userId: user.id, conversationId: conversation.id, runId: run.id }
}

function parseSseStream(text: string): Array<{ id?: number; type: string; data: unknown }> {
	const out: Array<{ id?: number; type: string; data: unknown }> = []
	for (const frame of text.split('\n\n')) {
		const lines = frame.split('\n')
		const idLine = lines.find((l) => l.startsWith('id: '))
		const eventLine = lines.find((l) => l.startsWith('event: '))
		const dataLine = lines.find((l) => l.startsWith('data: '))
		if (!eventLine || !dataLine) continue
		const id = idLine ? Number.parseInt(idLine.slice(4).trim(), 10) : undefined
		out.push({ id, type: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) })
	}
	return out
}

test.describe('runs/resume — replay events from terminated run', () => {
	test('replays events past since for a finished run and emits synthetic done', async ({ context }) => {
		const prefix = uniquePrefix('runs-resume-replay')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const seeded = await seedRunWithEvents(prefix, {
			state: 'completed',
			events: [
				{ type: 'tool_call', payload: { id: 'a', name: 'shell' } },
				{ type: 'tool_result', payload: { id: 'a', success: true } },
				{ type: 'tool_call', payload: { id: 'b', name: 'shell' } },
				{ type: 'done', payload: { messageId: 'm1' } },
			],
		})

		try {
			const response = await context.request.get(`/chat/${seeded.conversationId}/stream/resume?since=2`)
			expect(response.ok()).toBeTruthy()
			expect(response.headers()['content-type']).toContain('text/event-stream')

			const body = await response.text()
			const frames = parseSseStream(body)

			const replayedTypes = frames.map((f) => f.type)
			expect(replayedTypes.slice(0, 2)).toEqual(['tool_call', 'done'])
			expect(frames[0].id).toBe(3)
			expect(frames[1].id).toBe(4)

			const synthetic = frames[frames.length - 1]
			expect(synthetic.type).toBe('done')
			expect(synthetic.data).toMatchObject({ resumed: true, terminal: true })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('replays everything when since=0', async ({ context }) => {
		const prefix = uniquePrefix('runs-resume-fullreplay')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const seeded = await seedRunWithEvents(prefix, {
			state: 'completed',
			events: [
				{ type: 'tool_call', payload: { id: 'x' } },
				{ type: 'done', payload: { messageId: 'm1' } },
			],
		})
		try {
			const response = await context.request.get(`/chat/${seeded.conversationId}/stream/resume?since=0`)
			const body = await response.text()
			const frames = parseSseStream(body)
			expect(frames.map((f) => f.type)).toEqual(['tool_call', 'done', 'done'])
			expect(frames[0].id).toBe(1)
			expect(frames[1].id).toBe(2)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('returns 404 when the conversation has no run', async ({ context }) => {
		const prefix = uniquePrefix('runs-resume-norun')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const sql = getSql()
		const [user] = await sql<{ id: string }[]>`select id from users where is_active = true limit 1`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} Conversation`}, ${user.id}, ${'anthropic/claude-sonnet-4'}, 0, '0')
			returning id
		`
		try {
			const response = await context.request.get(`/chat/${conversation.id}/stream/resume?since=0`)
			expect(response.status()).toBe(404)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('rejects negative since', async ({ context }) => {
		const prefix = uniquePrefix('runs-resume-bad-since')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const seeded = await seedRunWithEvents(prefix, {
			state: 'completed',
			events: [{ type: 'done', payload: {} }],
		})
		try {
			const response = await context.request.get(`/chat/${seeded.conversationId}/stream/resume?since=-1`)
			expect(response.status()).toBe(400)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
