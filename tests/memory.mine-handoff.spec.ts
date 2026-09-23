import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'
import type { MineResult } from '../src/lib/memory/memory.server'

/**
 * A mining job does not let go of `mine:<conversationId>` while the conversation still has
 * turns to mine.
 *
 * The job reads the conversation when it starts and then spends seconds in the extractor. An
 * exchange that finished in that time enqueued `mine:<conversationId>`, which folded into the
 * still-running job — so its turns were only mined by the NEXT exchange's job, and after a
 * conversation's last exchange never automatically. The job now goes round again until nothing
 * is left, and gives its key back in the same transaction that checks.
 *
 * The miner is stood in for (it needs a model): "mining" a turn here means tombstoning it, the
 * same mark the real miner leaves on a turn it drops, so the unmined check is the real one.
 */

type Fixture = { conversationId: string; userId: string }

async function makeConversation(prefix: string): Promise<Fixture> {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} c`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	return { conversationId: conversation.id, userId }
}

async function addMessage(fixture: Fixture, sequence: number, content: string) {
	const sql = getSql()
	const [message] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, sequence)
		values (${fixture.conversationId}, 'user'::message_role, ${content}, ${sequence})
		returning id
	`
	return message.id
}

/** Mark every turn the miner would pick up as mined. Returns how many there were. */
async function markAllMined(fixture: Fixture): Promise<number> {
	const sql = getSql()
	const rows = await sql<{ message_id: string }[]>`
		insert into memory_message_tombstones (message_id, user_id, reason)
		select m.id, ${fixture.userId}::uuid, 'excluded_by_rule'
		from messages m
		where m.conversation_id = ${fixture.conversationId}
		  and not exists (select 1 from memory_message_tombstones t where t.message_id = m.id)
		returning message_id
	`
	return rows.length
}

const emptyResult = (): MineResult => ({
	drawerIds: [],
	wingIds: [],
	roomIds: [],
	closetIds: [],
	excludedTurns: 0,
	excludedByRule: [],
	extractorFallback: false,
})

/** A `memory_mine` job that is mid-run, the way a worker leaves it while the handler runs. */
async function insertRunningMineJob(fixture: Fixture) {
	const sql = getSql()
	const [job] = await sql<{ id: string; dedupe_key: string; payload: Record<string, unknown> }[]>`
		insert into jobs (type, status, dedupe_key, payload, user_id, started_at, attempt_count)
		values (
			'memory_mine', 'running'::job_status, ${`mine:${fixture.conversationId}`},
			${sql.json({ conversationId: fixture.conversationId })}, ${fixture.userId}, now(), 1
		)
		returning id, dedupe_key, payload
	`
	return { id: job.id, dedupeKey: job.dedupe_key, payload: job.payload }
}

/** The enqueue a finished exchange makes; scheduled far ahead so no worker runs what it creates. */
async function enqueueLikeAnExchange(fixture: Fixture) {
	const { enqueueJobWithOutcome } = await import('../src/lib/jobs/jobs.server')
	return enqueueJobWithOutcome({
		type: 'memory_mine',
		dedupeKey: `mine:${fixture.conversationId}`,
		payload: { conversationId: fixture.conversationId },
		userId: fixture.userId,
		scheduledAt: new Date(Date.now() + 24 * 60 * 60_000),
	})
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`
		delete from jobs where type = 'memory_mine'
		and payload->>'conversationId' in (select id::text from conversations where title like ${`${prefix}%`})
	`
	// Messages cascade from the conversation, and tombstones from the messages.
	await sql`delete from conversations where title like ${`${prefix}%`}`
}

test.describe('memory/mine-handoff — the job keeps its key while there is more to mine', () => {
	test('an exchange that lands mid-mine is mined by the same job before it lets go', async () => {
		const prefix = uniquePrefix('mine-handoff-midrun')
		try {
			const fixture = await makeConversation(prefix)
			await addMessage(fixture, 1, `${prefix} first exchange`)
			const job = await insertRunningMineJob(fixture)

			const minedPerPass: number[] = []
			const { executeMemoryMineJob } = await import('../src/lib/memory/memory-handler.server')
			const result = await executeMemoryMineJob(job, async () => {
				minedPerPass.push(await markAllMined(fixture))
				if (minedPerPass.length === 1) {
					// The next exchange finishes while this pass is still in the extractor.
					await addMessage(fixture, 2, `${prefix} second exchange`)
					const folded = await enqueueLikeAnExchange(fixture)
					expect(folded.created, 'the enqueue folds into the job that is mining').toBe(false)
					expect(folded.job.id).toBe(job.id)
				}
				return emptyResult()
			})

			expect(minedPerPass, 'the second pass mines the turn that arrived during the first').toEqual([1, 1])
			expect(result.passes).toBe(2)

			const sql = getSql()
			const [row] = await sql<{ dedupe_key: string }[]>`select dedupe_key from jobs where id = ${job.id}`
			expect(row.dedupe_key, 'the key is given back, still readable').toBe(`mine:${fixture.conversationId}#${job.id}`)

			const next = await enqueueLikeAnExchange(fixture)
			expect(next.created, 'the exchange after it gets a job of its own').toBe(true)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a quiet conversation is mined once, and the next exchange queues a fresh job even while this one is still finishing', async () => {
		const prefix = uniquePrefix('mine-handoff-quiet')
		try {
			const fixture = await makeConversation(prefix)
			await addMessage(fixture, 1, `${prefix} only exchange`)
			const job = await insertRunningMineJob(fixture)

			let calls = 0
			const { executeMemoryMineJob } = await import('../src/lib/memory/memory-handler.server')
			const result = await executeMemoryMineJob(job, async () => {
				calls += 1
				await markAllMined(fixture)
				return emptyResult()
			})
			expect(calls).toBe(1)
			expect(result.passes).toBe(1)

			// The row is still `running` — the worker has not recorded the result yet — and the
			// next exchange must not fold into it.
			const next = await enqueueLikeAnExchange(fixture)
			expect(next.created).toBe(true)
			expect(next.job.id).not.toBe(job.id)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a turn that never gets marked cannot keep a job going forever', async () => {
		const prefix = uniquePrefix('mine-handoff-bounded')
		try {
			const fixture = await makeConversation(prefix)
			await addMessage(fixture, 1, `${prefix} never mined`)
			const job = await insertRunningMineJob(fixture)

			const { executeMemoryMineJob, MAX_MINE_PASSES } = await import('../src/lib/memory/memory-handler.server')
			let calls = 0
			const result = await executeMemoryMineJob(job, async () => {
				calls += 1
				return emptyResult()
			})
			expect(calls).toBe(MAX_MINE_PASSES)
			expect(result.passes).toBe(MAX_MINE_PASSES)
		} finally {
			await cleanup(prefix)
		}
	})

	test('releaseDedupeKey: a job without a key has nothing to give back', async () => {
		const sql = getSql()
		const [job] = await sql<{ id: string }[]>`
			insert into jobs (type, status) values (${uniquePrefix('release-no-key')}, 'running'::job_status)
			returning id
		`
		try {
			const { releaseDedupeKey } = await import('../src/lib/jobs/jobs.server')
			expect(await releaseDedupeKey(job.id)).toBe(true)
			const [row] = await sql<{ dedupe_key: string | null }[]>`select dedupe_key from jobs where id = ${job.id}`
			expect(row.dedupe_key).toBeNull()
		} finally {
			await sql`delete from jobs where id = ${job.id}`
		}
	})
})
