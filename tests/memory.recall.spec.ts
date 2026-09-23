import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { stubOpenRouter, type OpenRouterStub } from './openrouter-stub'

/**
 * Recall — what a chat turn's memory lookup sends out, and what it finds.
 *
 * OpenRouter is stood in for (./openrouter-stub): recall embeds the user's message, and the
 * point of several of these specs is exactly what leaves the process.
 */

/** Serialized with the specs that read the shared cost ledger: recall logs its embedding. */
let releaseBudgetLock: (() => Promise<void>) | null = null
let stub: OpenRouterStub | null = null
let startedAt = new Date()
let prefix = ''

test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
	startedAt = new Date()
	prefix = uniquePrefix('mem-recall')
})

test.afterEach(async () => {
	stub?.restore()
	stub = null
	const sql = getSql()
	await sql`delete from memory_recall_events where query like ${`%${prefix}%`}`
	// Rooms, closets, drawers and their recall events cascade from the wing.
	await sql`delete from memory_wings where name like ${`${prefix}%`}`
	await sql`delete from llm_usage where source = 'memory_embed' and created_at >= ${startedAt}`
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

test.describe('memory/recall — exclusion rules apply to the query', () => {
	test('a message with a key in it is not embedded, not logged, and recalls nothing', async () => {
		// The miner drops this turn under "Provider API key". Recall used to embed it first —
		// sending the key to the embeddings endpoint with a day of caching requested — and
		// then keep it in memory_recall_events for 30 days, shown on every recalled drawer.
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const { recallForUser } = await import('../src/lib/memory/memory.server')

		const query = `${prefix} why does sk-proj-AbCdEf0123456789XYZ fail with 401?`
		const recalled = await recallForUser(userId, query, { recallSource: 'chat' })

		expect(recalled).toEqual([])
		expect(stub.callsTo('/embeddings'), 'the query never left the process').toHaveLength(0)
		const [{ n }] = await getSql()<{ n: number }[]>`
			select count(*)::int as n from memory_recall_events where query like ${`%sk-proj-AbCdEf0123456789XYZ%`}
		`
		expect(n).toBe(0)
	})

	test('an ordinary message is embedded — without asking OpenRouter to cache it', async () => {
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const { recallForUser } = await import('../src/lib/memory/memory.server')

		await recallForUser(userId, `${prefix} what did we decide about the van battery?`, { recallSource: 'search' })

		const [call] = stub.callsTo('/embeddings')
		expect(call.body?.input).toEqual([`${prefix} what did we decide about the van battery?`])
		expect(call.headers['x-openrouter-cache']).toBeUndefined()
		expect(call.headers['x-openrouter-cache-ttl']).toBeUndefined()
	})

	test("the same turn's skill list does not embed a message with a key in it either", async () => {
		// The chat turn also ranks skills by the message, and that ranker embedded it with a day
		// of caching requested — so the key recall kept in the process left it anyway.
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const { buildSkillSummariesText } = await import('../src/lib/chat/stream-slots.server')
		const { listSkillSummaries } = await import('../src/lib/skills/skills.server')

		const text = await buildSkillSummariesText({
			userId,
			userQuery: `${prefix} why does sk-proj-AbCdEf0123456789XYZ fail with 401?`,
			skillTopK: 8,
		})

		expect(stub.callsTo('/embeddings'), 'the message never left the process').toHaveLength(0)
		// Unranked instead: every skill is listed, as when embedding is unavailable.
		for (const skill of await listSkillSummaries()) expect(text).toContain(`- ${skill.name}:`)
	})

	test('an ordinary message ranks the skills — without asking OpenRouter to cache it', async () => {
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const { buildSkillSummariesText } = await import('../src/lib/chat/stream-slots.server')

		await buildSkillSummariesText({ userId, userQuery: `${prefix} how do I rotate the van battery?`, skillTopK: 8 })

		const [call] = stub.callsTo('/embeddings')
		expect(call.body?.input).toEqual([`${prefix} how do I rotate the van battery?`])
		expect(call.headers['x-openrouter-cache']).toBeUndefined()
		expect(call.headers['x-openrouter-cache-ttl']).toBeUndefined()
	})
})

/** wing → room → closet under `prefix`, returning the closet to hang drawers off. */
async function makeCloset(userId: string) {
	const sql = getSql()
	const [wing] = await sql<{ id: string }[]>`
		insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`})
		returning id
	`
	const [room] = await sql<{ id: string }[]>`
		insert into memory_rooms (wing_id, label) values (${wing.id}, 'r') returning id
	`
	const [closet] = await sql<{ id: string }[]>`
		insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
	`
	return closet.id
}

/** The query vector the stub hands recall: every component 1. */
const QUERY_VECTOR = Array.from({ length: 1536 }, () => 1)

test.describe('memory/recall — candidates in a shared index', () => {
	test.setTimeout(120_000)

	test("the user's drawers are found when the index neighbourhood is full of drawers recall must skip", async () => {
		// The HNSW index covers everyone's drawers, and the recall filter (this user, not
		// never-recall) is applied after the scan, which returned `hnsw.ef_search` = 40 rows. Here
		// the 40 nearest are all never-recall — as another user's drawers would be — so the
		// filter emptied the pool and recall came back with nothing.
		stub = stubOpenRouter({ embeddings: () => [QUERY_VECTOR] })
		const userId = await getActiveUserId()
		const closetId = await makeCloset(userId)
		const sql = getSql()
		// 2,000 drawers pointing exactly at the query.
		await sql`
			insert into memory_drawers (closet_id, user_id, content, token_count, embedding, never_recall)
			select ${closetId}, ${userId}, ${`${prefix} noise `} || g::text, 1, array_fill(1::real, array[1536])::vector, true
			from generate_series(1, 2000) g
		`
		// Three recallable ones further out: half their components match the query.
		const wanted = [`${prefix} wanted 1`, `${prefix} wanted 2`, `${prefix} wanted 3`]
		for (const content of wanted) {
			await sql`
				insert into memory_drawers (closet_id, user_id, content, token_count, embedding)
				values (
					${closetId}, ${userId}, ${content}, 1,
					(select array_agg(case when g <= 768 then 1::real else 0::real end order by g)
					 from generate_series(1, 1536) g)::vector
				)
			`
		}

		const { recall } = await import('../src/lib/memory/retrieval.server')
		const recalled = await recall(userId, 'zzqx', { topK: 100, candidatePoolSize: 50 })

		const contents = recalled.map((drawer) => drawer.content)
		for (const content of wanted) expect(contents, content).toContain(content)
		expect(contents.some((content) => content.startsWith(`${prefix} noise`)), 'never-recall stays out').toBe(false)
	})

	test('a pinned drawer is considered however far it is from the query', async () => {
		stub = stubOpenRouter({ embeddings: () => [QUERY_VECTOR] })
		const userId = await getActiveUserId()
		const closetId = await makeCloset(userId)
		const sql = getSql()
		await sql`
			insert into memory_drawers (closet_id, user_id, content, token_count, embedding, never_recall)
			select ${closetId}, ${userId}, ${`${prefix} noise `} || g::text, 1, array_fill(1::real, array[1536])::vector, true
			from generate_series(1, 500) g
		`
		// Pointing away from the query: the farthest drawer there is.
		const [pinned] = await sql<{ id: string }[]>`
			insert into memory_drawers (closet_id, user_id, content, token_count, embedding, pinned)
			values (${closetId}, ${userId}, ${`${prefix} pinned`}, 1, array_fill(-1::real, array[1536])::vector, true)
			returning id
		`

		const { recall } = await import('../src/lib/memory/retrieval.server')
		const recalled = await recall(userId, 'zzqx', { topK: 1_000, candidatePoolSize: 5 })

		const found = recalled.find((drawer) => drawer.drawerId === pinned.id)
		expect(found, 'pinned drawers are force-added to the pool').toBeDefined()
		expect(found?.pinnedBoost).toBeGreaterThan(0)
	})
})

test.describe('memory/recall — recency', () => {
	test('a recent drawer outranks an old one that is otherwise identical', async () => {
		// Production recall never passed a query date, so the temporal part of the score was 0
		// for every drawer while the recall log recorded a 0.25 weight for it.
		stub = stubOpenRouter({ embeddings: () => [QUERY_VECTOR] })
		const userId = await getActiveUserId()
		const closetId = await makeCloset(userId)
		const sql = getSql()
		const insert = (content: string, daysAgo: number) => sql<{ id: string }[]>`
			insert into memory_drawers (closet_id, user_id, content, token_count, embedding, occurred_at)
			values (
				${closetId}, ${userId}, ${content}, 1, array_fill(1::real, array[1536])::vector,
				now() - make_interval(days => ${daysAgo})
			)
			returning id
		`
		const [[recent], [old]] = [await insert(`${prefix} decided last week`, 7), await insert(`${prefix} decided in spring`, 120)]

		const { recallForUser } = await import('../src/lib/memory/memory.server')
		const recalled = await recallForUser(userId, `${prefix} battery decision`, { topK: 1_000, recallSource: 'search' })

		const recentHit = recalled.find((drawer) => drawer.drawerId === recent.id)
		const oldHit = recalled.find((drawer) => drawer.drawerId === old.id)
		expect(recentHit?.temporalScore).toBeGreaterThan(0.5)
		expect(oldHit?.temporalScore).toBeLessThan(recentHit?.temporalScore ?? 0)
		expect(recalled.indexOf(recentHit!)).toBeLessThan(recalled.indexOf(oldHit!))
	})

	test('a mined drawer is dated when its message was said, not when the conversation started', async () => {
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const sql = getSql()
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost, created_at)
			values (${`${prefix} long chat`}, ${userId}, 'claude-sonnet-5', 0, '0', now() - interval '60 days')
			returning id
		`
		try {
			const [early] = await sql<{ id: string; created_at: Date }[]>`
				insert into messages (conversation_id, role, content, sequence, created_at)
				values (${conversation.id}, 'user'::message_role, 'We chose the 48V battery.', 1, now() - interval '59 days')
				returning id, created_at
			`
			const [late] = await sql<{ id: string; created_at: Date }[]>`
				insert into messages (conversation_id, role, content, sequence, created_at)
				values (${conversation.id}, 'user'::message_role, 'Switching to the 24V battery.', 2, now() - interval '1 day')
				returning id, created_at
			`

			const { mineConversation } = await import('../src/lib/memory/memory.server')
			await mineConversation({ conversationId: conversation.id })

			const drawers = await sql<{ source_message_id: string; occurred_at: Date }[]>`
				select source_message_id, occurred_at from memory_drawers
				where source_message_id in (${early.id}, ${late.id})
			`
			const dated = Object.fromEntries(drawers.map((row) => [row.source_message_id, row.occurred_at.getTime()]))
			expect(dated[early.id]).toBe(early.created_at.getTime())
			expect(dated[late.id]).toBe(late.created_at.getTime())
		} finally {
			await sql`delete from conversations where id = ${conversation.id}`
		}
	})

	test('an embedding failure leaves no empty wing or room behind', async () => {
		// The room used to be created before the embedding call; when that failed (rate limit,
		// no credit) the palace kept an empty room, which the wing panel opened first.
		stub = stubOpenRouter({
			embeddings: () =>
				new Response(JSON.stringify({ error: { code: 402, message: 'Insufficient credits' } }), {
					status: 402,
					headers: { 'content-type': 'application/json' },
				}),
		})
		const userId = await getActiveUserId()
		const { mineSession } = await import('../src/lib/memory/mining.server')

		await expect(
			mineSession({
				userId,
				session: {
					conversationId: null,
					occurredAt: new Date(),
					sessionLabel: `${prefix} unlucky chat`,
					turns: [{ role: 'user', content: 'The van battery is 48V.' }],
				},
			}),
		).rejects.toThrow(/402/)

		const [{ n }] = await getSql()<{ n: number }[]>`
			select count(*)::int as n from memory_wings where name like ${`${prefix}%`}
		`
		expect(n).toBe(0)
	})
})
