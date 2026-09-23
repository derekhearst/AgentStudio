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
})
