import { expect, test } from '@playwright/test'
import { and, eq, like, sql as dsql } from 'drizzle-orm'
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
const QUERY_VECTOR_TEXT = `[${QUERY_VECTOR.join(',')}]`

/**
 * 2,000 never-recall drawers exactly at the query vector, and three recallable ones further
 * out (half their components match it), under `prefix`. Analysed afterwards, so the planner
 * decides with the rows it will actually meet.
 */
async function seedCrowdedIndex(userId: string) {
	const closetId = await makeCloset(userId)
	const sql = getSql()
	await sql`
		insert into memory_drawers (closet_id, user_id, content, token_count, embedding, never_recall)
		select ${closetId}, ${userId}, ${`${prefix} noise `} || g::text, 1, array_fill(1::real, array[1536])::vector, true
		from generate_series(1, 2000) g
	`
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
	await sql`analyze memory_drawers`
	return wanted
}

/** Whether the installed pgvector has `hnsw.iterative_scan` (0.8+). */
async function pgvectorHasIterativeScan() {
	const [row] = await getSql()<{ extversion: string }[]>`select extversion from pg_extension where extname = 'vector'`
	const [major = 0, minor = 0] = String(row?.extversion ?? '0.0')
		.split('.')
		.map(Number)
	return major > 0 || minor >= 8
}

const HNSW_INDEX = 'memory_drawers_embedding_hnsw_idx'

test.describe('memory/recall — candidates in a crowded index', () => {
	/*
	 * The HNSW index holds every drawer, and recall's filter (this user, not never-recall, has an
	 * embedding) is applied after the index scan, which returned `hnsw.ef_search` = 40 rows. When
	 * the 40 nearest were all drawers recall must skip, the filter emptied the pool and recall
	 * came back with nothing.
	 *
	 * The drawers to skip here are never-recall ones. Another user's would be the same problem
	 * in a shared database, but this instance holds exactly one user (`users_singleton`), so
	 * none can be seeded.
	 *
	 * In a table this small the planner may rather read the user's rows and sort — an exact
	 * search, which never shows the problem — where a large table picks the index. A spec that
	 * means the index path holds the planner to it (`enable_sort = off`, for its transaction
	 * only) and checks with EXPLAIN that it got it, so it cannot pass by testing something else.
	 */
	test.setTimeout(120_000)

	test('the query recall used to run, held to the index, loses the drawers it should find', async () => {
		// The scenario, reproduced. If this ever finds them, the specs below prove nothing.
		const userId = await getActiveUserId()
		const wanted = await seedCrowdedIndex(userId)
		const iterative = await pgvectorHasIterativeScan()

		const { plan, found } = await getSql().begin(async (tx) => {
			await tx`set local enable_sort = off`
			await tx`select set_config('hnsw.ef_search', '40', true)`
			if (iterative) await tx`select set_config('hnsw.iterative_scan', 'off', true)`
			const plan = await tx<{ 'QUERY PLAN': string }[]>`
				explain select content from memory_drawers
				where user_id = ${userId} and never_recall = false and embedding is not null
				order by embedding <=> ${QUERY_VECTOR_TEXT}::vector
				limit 50
			`
			const found = await tx<{ content: string }[]>`
				select content from memory_drawers
				where user_id = ${userId} and never_recall = false and embedding is not null
				order by embedding <=> ${QUERY_VECTOR_TEXT}::vector
				limit 50
			`
			return { plan: plan.map((row) => row['QUERY PLAN']).join('\n'), found }
		})

		expect(plan, 'served by the HNSW index').toContain(HNSW_INDEX)
		const contents = found.map((row) => row.content)
		expect(wanted.filter((content) => contents.includes(content)).length).toBeLessThan(wanted.length)
	})

	test("recall finds a small palace's drawers however crowded the index is", async () => {
		// A palace this small is searched exactly, so what the index would have returned no
		// longer matters.
		stub = stubOpenRouter({ embeddings: () => [QUERY_VECTOR] })
		const userId = await getActiveUserId()
		const wanted = await seedCrowdedIndex(userId)

		const { recall } = await import('../src/lib/memory/retrieval.server')
		const recalled = await recall(userId, 'zzqx', { topK: 100, candidatePoolSize: 50 })

		const contents = recalled.map((drawer) => drawer.content)
		for (const content of wanted) expect(contents, content).toContain(content)
		expect(contents.some((content) => content.startsWith(`${prefix} noise`)), 'never-recall stays out').toBe(false)
	})

	test('through the index, the scan keeps going until the pool is full', async () => {
		// The path a big palace takes. Held to the index as above, the scan must not stop at
		// the 40 never-recall drawers nearest the query.
		const userId = await getActiveUserId()
		const wanted = await seedCrowdedIndex(userId)
		const { db } = await import('../src/lib/db.server')
		const { memoryDrawers } = await import('../src/lib/memory/memory.schema')
		const { nearestRecallable } = await import('../src/lib/memory/retrieval.server')
		const where = and(
			eq(memoryDrawers.userId, userId),
			eq(memoryDrawers.neverRecall, false),
			dsql`${memoryDrawers.embedding} is not null`,
			// Other specs' drawers sit at the query vector too; only this spec's are counted.
			like(memoryDrawers.content, `${prefix}%`),
		)

		const paths: string[] = []
		let plan = ''
		const rows = await nearestRecallable({
			query: async (orderBy, run) => {
				const statement = dsql`
					select ${memoryDrawers.content} as content from ${memoryDrawers}
					where ${where} order by ${orderBy} limit ${wanted.length}
				`
				if (run === db) {
					paths.push('exact')
				} else {
					paths.push('index')
					await run.execute(dsql`set local enable_sort = off`)
					const explained = await run.execute<{ 'QUERY PLAN': string }>(dsql`explain ${statement}`)
					plan = [...explained].map((row) => row['QUERY PLAN']).join('\n')
				}
				return [...(await run.execute<{ content: string }>(statement))]
			},
			// Too big to search exactly, so the index is tried first.
			countUpTo: async () => 1,
			exactAtMost: 0,
			vec: QUERY_VECTOR_TEXT,
			limit: wanted.length,
		})

		expect(paths[0]).toBe('index')
		expect(plan, 'served by the HNSW index').toContain(HNSW_INDEX)
		// By the iterative scan (pgvector 0.8+) or, failing that, the exact search after it.
		expect(paths.length).toBeLessThanOrEqual(2)
		expect(rows.map((row) => row.content).sort()).toEqual([...wanted].sort())
	})

	test('the pinned lookup recall used to run, held to the index, loses a far pinned drawer', async () => {
		// Why the pinned lookup is exact (`+ 0`). On a table this small the planner answers the
		// old query from the (user_id, pinned) b-tree and a sort, which finds every pinned drawer
		// — so the recall-level spec below passes with or without the fix. Held to the index, as
		// the planner may choose once the table is large, the old query stops at the 40 drawers
		// nearest the query and a far pinned drawer is never seen; the exact form cannot use the
		// index at all.
		const userId = await getActiveUserId()
		const closetId = await makeCloset(userId)
		const sql = getSql()
		await sql`
			insert into memory_drawers (closet_id, user_id, content, token_count, embedding, never_recall)
			select ${closetId}, ${userId}, ${`${prefix} noise `} || g::text, 1, array_fill(1::real, array[1536])::vector, true
			from generate_series(1, 500) g
		`
		const [pinned] = await sql<{ id: string }[]>`
			insert into memory_drawers (closet_id, user_id, content, token_count, embedding, pinned)
			values (${closetId}, ${userId}, ${`${prefix} pinned`}, 1, array_fill(-1::real, array[1536])::vector, true)
			returning id
		`
		await sql`analyze memory_drawers`
		const iterative = await pgvectorHasIterativeScan()

		const planText = (rows: { 'QUERY PLAN': string }[]) => rows.map((row) => row['QUERY PLAN']).join('\n')
		const { before, after } = await sql.begin(async (tx) => {
			await tx`set local enable_sort = off`
			await tx`select set_config('hnsw.ef_search', '40', true)`
			if (iterative) await tx`select set_config('hnsw.iterative_scan', 'off', true)`
			// The old lookup: ordered by the distance as written, which the index can serve.
			const oldPlan = await tx<{ 'QUERY PLAN': string }[]>`
				explain select id from memory_drawers
				where user_id = ${userId} and never_recall = false and embedding is not null and pinned = true
				order by embedding <=> ${QUERY_VECTOR_TEXT}::vector
				limit 25
			`
			const oldRows = await tx<{ id: string }[]>`
				select id from memory_drawers
				where user_id = ${userId} and never_recall = false and embedding is not null and pinned = true
				order by embedding <=> ${QUERY_VECTOR_TEXT}::vector
				limit 25
			`
			// Recall's lookup now: the same, ordered by the distance `+ 0`.
			const newPlan = await tx<{ 'QUERY PLAN': string }[]>`
				explain select id from memory_drawers
				where user_id = ${userId} and never_recall = false and embedding is not null and pinned = true
				order by (embedding <=> ${QUERY_VECTOR_TEXT}::vector) + 0
				limit 25
			`
			const newRows = await tx<{ id: string }[]>`
				select id from memory_drawers
				where user_id = ${userId} and never_recall = false and embedding is not null and pinned = true
				order by (embedding <=> ${QUERY_VECTOR_TEXT}::vector) + 0
				limit 25
			`
			return {
				before: { plan: planText(oldPlan), ids: oldRows.map((row) => row.id) },
				after: { plan: planText(newPlan), ids: newRows.map((row) => row.id) },
			}
		})

		expect(before.plan, 'the old query, served by the HNSW index').toContain(HNSW_INDEX)
		expect(before.ids).not.toContain(pinned.id)
		expect(after.plan, 'the exact form cannot use it').not.toContain(HNSW_INDEX)
		expect(after.ids).toContain(pinned.id)
	})

	test('a pinned drawer is considered however far it is from the query', async () => {
		// A regression guard for the whole path, not evidence for the fix: see the spec above.
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

test.describe('memory/recall — which search nearestRecallable runs', () => {
	/**
	 * Stand-in queries that record which search they were asked for — the exact one runs on the
	 * pool (`db`), the index one inside nearestRecallable's transaction — and return rows named
	 * after it: as many as the palace holds for the exact search, `indexReturns` for the index.
	 */
	async function drive(opts: { recallable: number; indexReturns: number; limit?: number }) {
		const { db } = await import('../src/lib/db.server')
		const { nearestRecallable } = await import('../src/lib/memory/retrieval.server')
		const limit = opts.limit ?? 50
		const paths: string[] = []
		const countedUpTo: number[] = []
		const rows = await nearestRecallable({
			query: async (_orderBy, run) => {
				const path = run === db ? 'exact' : 'index'
				paths.push(path)
				const n = path === 'index' ? opts.indexReturns : Math.min(limit, opts.recallable)
				return Array.from({ length: n }, (_, i) => `${path} ${i}`)
			},
			countUpTo: async (atMost) => {
				countedUpTo.push(atMost)
				return Math.min(atMost, opts.recallable)
			},
			vec: QUERY_VECTOR_TEXT,
			limit,
		})
		return { paths, rows, countedUpTo }
	}

	test('a small palace is searched exactly, without walking the index first', async () => {
		// Every new palace is smaller than the pool (50, or 20 with rerank). Through the index it
		// could never fill it, so every chat turn walked up to `hnsw.max_scan_tuples` (20,000)
		// index tuples and then ran the exact search anyway.
		const { EXACT_SEARCH_MAX_DRAWERS } = await import('../src/lib/memory/retrieval.server')
		const small = await drive({ recallable: 12, indexReturns: 12 })
		expect(small.paths).toEqual(['exact'])
		expect(small.countedUpTo, 'the count stops one past the threshold').toEqual([EXACT_SEARCH_MAX_DRAWERS + 1])

		expect((await drive({ recallable: EXACT_SEARCH_MAX_DRAWERS, indexReturns: 50 })).paths).toEqual(['exact'])
		expect((await drive({ recallable: EXACT_SEARCH_MAX_DRAWERS + 1, indexReturns: 50 })).paths).toEqual(['index'])
	})

	test('a bigger palace goes through the index, and stops there when the pool is full', async () => {
		const { paths, rows } = await drive({ recallable: 10_000, indexReturns: 50 })
		expect(paths).toEqual(['index'])
		expect(rows).toHaveLength(50)
	})

	test('a bigger palace whose index scan comes up short gets the exact search instead', async () => {
		const { paths, rows } = await drive({ recallable: 10_000, indexReturns: 7 })
		expect(paths).toEqual(['index', 'exact'])
		expect(rows).toHaveLength(50)
		expect(rows[0]).toBe('exact 0')
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
