import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

type RunRow = {
	id: string
	stream_blocks: Array<Record<string, unknown>>
	current_round: number
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

async function readRun(runId: string): Promise<RunRow | null> {
	const sql = getSql()
	const [row] = await sql<RunRow[]>`
		select id, stream_blocks, current_round from chat_runs where id = ${runId}
	`
	return row ?? null
}

test.describe('runs/blocks — stream blocks and round counter persist', () => {
	test('default values are empty array and round 0', async () => {
		const prefix = uniquePrefix('runs-blocks-default')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		try {
			const row = await readRun(seeded.runId)
			expect(row!.stream_blocks).toEqual([])
			expect(row!.current_round).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('persistRunBlocks-shaped writes round-trip through the column', async () => {
		const prefix = uniquePrefix('runs-blocks-snapshot')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		const sql = getSql()
		try {
			const blocks = [
				{ kind: 'thinking', content: 'considering options' },
				{ kind: 'text', content: 'hello world' },
				{
					kind: 'tool',
					name: 'shell',
					arguments: { command: 'echo hi' },
					result: { stdout: 'hi\n' },
					success: true,
					executionMs: 12,
				},
			]
			await sql`update chat_runs set stream_blocks = ${sql.json(blocks)} where id = ${seeded.runId}`

			const row = await readRun(seeded.runId)
			expect(row!.stream_blocks).toHaveLength(3)
			expect(row!.stream_blocks[0]).toMatchObject({ kind: 'thinking', content: 'considering options' })
			expect(row!.stream_blocks[2]).toMatchObject({ kind: 'tool', name: 'shell', success: true })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('current_round can be advanced and read back', async () => {
		const prefix = uniquePrefix('runs-blocks-round')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		const sql = getSql()
		try {
			await sql`update chat_runs set current_round = 3 where id = ${seeded.runId}`
			const row = await readRun(seeded.runId)
			expect(row!.current_round).toBe(3)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('snapshot replace overwrites the prior block array', async () => {
		const prefix = uniquePrefix('runs-blocks-replace')
		await cleanupPrefixedRecords(prefix)
		const seeded = await seedRun(prefix)
		const sql = getSql()
		try {
			await sql`update chat_runs set stream_blocks = ${sql.json([{ kind: 'text', content: 'first' }])} where id = ${seeded.runId}`
			await sql`update chat_runs set stream_blocks = ${sql.json([
				{ kind: 'text', content: 'first' },
				{ kind: 'text', content: 'second' },
			])} where id = ${seeded.runId}`

			const row = await readRun(seeded.runId)
			expect(row!.stream_blocks).toHaveLength(2)
			expect(row!.stream_blocks.map((b) => (b as { content?: string }).content)).toEqual(['first', 'second'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
