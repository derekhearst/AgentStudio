import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { invalidModelResponse, stubOpenRouter, type OpenRouterStub } from './openrouter-stub'
import { toOpenRouterModelId } from '../src/lib/llm/openrouter-model'
import type { RetrievedDrawer } from '../src/lib/memory/retrieval.server'

/**
 * The memory extractor and reranker talk to OpenRouter, which only accepts its own catalogue
 * slugs (`anthropic/claude-haiku-4.5`). The engine migration moved the app's default model and
 * the stored rerank setting to the Agent SDK's bare ids (`claude-sonnet-5`, `claude-haiku-4-5`),
 * and `chat()` passed them through — so every extraction and every rerank was a 400 that both
 * callers caught and quietly degraded on: every conversation filed under its title in one
 * `general` closet, every rerank a wasted round trip. Nothing said so.
 *
 * OpenRouter is stood in for (see ./openrouter-stub), so these run the real callers and look
 * at what they sent.
 */

test.describe('llm/openrouter model ids', () => {
	const cases: Array<[string, string]> = [
		['claude-haiku-4-5', 'anthropic/claude-haiku-4.5'],
		['claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'],
		['claude-opus-4-1-20250805', 'anthropic/claude-opus-4.1'],
		['claude-3-5-sonnet-20241022', 'anthropic/claude-3.5-sonnet'],
		['claude-sonnet-4-5[1m]', 'anthropic/claude-sonnet-4.5'],
		['claude-sonnet-5', 'anthropic/claude-sonnet-5'],
		['claude-sonnet-4', 'anthropic/claude-sonnet-4'],
		['claude-opus-5-5', 'anthropic/claude-opus-5.5'],
		['claude-3-haiku', 'anthropic/claude-3-haiku'],
		['  claude-sonnet-5  ', 'anthropic/claude-sonnet-5'],
		['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5'],
		// Written the SDK's way under the vendor prefix: still needs the dot.
		['anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'],
		// OpenRouter's own variant suffix is kept.
		['anthropic/claude-sonnet-5:batch', 'anthropic/claude-sonnet-5:batch'],
		['openai/gpt-4o-mini', 'openai/gpt-4o-mini'],
		['moonshotai/kimi-k2-0905', 'moonshotai/kimi-k2-0905'],
		['google/gemini-2.5-flash', 'google/gemini-2.5-flash'],
		// An alias names no specific model, so it is not guessed at.
		['sonnet', 'sonnet'],
		['', ''],
	]
	for (const [input, expected] of cases) {
		test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(toOpenRouterModelId(input)).toBe(expected)
		})
	}

	test('the defaults research falls back to map to catalogue ids', async () => {
		// Every research planner call was a 400 while these went out bare.
		const { DEFAULT_RESEARCH_CONFIG } = await import('../src/lib/research/research-config')
		expect(toOpenRouterModelId(DEFAULT_RESEARCH_CONFIG.plannerModel)).toBe('anthropic/claude-sonnet-5')
		expect(toOpenRouterModelId(DEFAULT_RESEARCH_CONFIG.synthesizerModel)).toBe('anthropic/claude-sonnet-5')
	})
})

test.describe('llm/chat — what reaches OpenRouter', () => {
	let stub: OpenRouterStub | null = null
	test.afterEach(() => {
		stub?.restore()
		stub = null
	})

	test('a bare Claude id is sent as its OpenRouter slug, through the SDK and the cached path', async () => {
		stub = stubOpenRouter({ chat: () => 'ok' })
		const { chat } = await import('../src/lib/llm/chat.server')

		await chat([{ role: 'user', content: 'hi' }], 'claude-haiku-4-5')
		await chat([{ role: 'user', content: 'hi' }], 'claude-haiku-4-5', { cache: { enabled: true, ttlSeconds: 60 } })

		const models = stub.callsTo('/chat/completions').map((call) => call.body?.model)
		expect(models).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5'])
	})

	test('the default model is sent as an OpenRouter slug', async () => {
		stub = stubOpenRouter({ chat: () => 'ok' })
		const { chat, DEFAULT_MODEL } = await import('../src/lib/llm/chat.server')
		await chat([{ role: 'user', content: 'hi' }])
		const [call] = stub.callsTo('/chat/completions')
		expect(call.body?.model).toBe(toOpenRouterModelId(DEFAULT_MODEL))
		expect(String(call.body?.model)).toMatch(/^anthropic\//)
	})
})

function candidate(id: string, content: string): RetrievedDrawer {
	return {
		drawerId: id,
		roomId: 'room',
		closetId: 'closet',
		wingId: 'wing',
		content,
		role: 'user',
		occurredAt: new Date(),
		conversationId: null,
		wingName: 'w',
		roomLabel: 'r',
		closetTopic: 't',
		pinned: false,
		semanticScore: 0,
		keywordScore: 0,
		temporalScore: 0,
		pinnedBoost: 0,
		finalScore: 0,
	}
}

test.describe('memory/rerank — model id', () => {
	// The reranker logs its usage to the shared cost ledger.
	let releaseBudgetLock: (() => Promise<void>) | null = null
	let stub: OpenRouterStub | null = null
	let startedAt = new Date()
	test.beforeEach(async () => {
		releaseBudgetLock = await acquireGlobalStateLock('budget-state')
		startedAt = new Date()
	})
	test.afterEach(async () => {
		stub?.restore()
		stub = null
		await getSql()`delete from llm_usage where source = 'memory_rerank' and created_at >= ${startedAt}`
		await releaseBudgetLock?.()
		releaseBudgetLock = null
	})

	const candidates = [candidate('a', 'first'), candidate('b', 'second'), candidate('c', 'third')]

	test('the default and the stored bare setting both reach OpenRouter as a slug, and the ranking is used', async () => {
		stub = stubOpenRouter({ chat: () => JSON.stringify({ rankedIds: ['c', 'a', 'b'] }) })
		const { rerank } = await import('../src/lib/memory/rerank.server')

		const byDefault = await rerank('which one?', candidates, { keepTopK: 3 })
		const bySetting = await rerank('which one?', candidates, { keepTopK: 3, model: 'claude-haiku-4-5' })

		expect(byDefault.map((d) => d.drawerId)).toEqual(['c', 'a', 'b'])
		expect(bySetting.map((d) => d.drawerId)).toEqual(['c', 'a', 'b'])
		const models = stub.callsTo('/chat/completions').map((call) => call.body?.model)
		expect(models).toEqual(['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4.5'])
	})

	test('a refused call keeps the hybrid order instead of failing recall', async () => {
		stub = stubOpenRouter({ chat: (body) => invalidModelResponse(String(body.model)) })
		const { rerank } = await import('../src/lib/memory/rerank.server')
		const result = await rerank('which one?', candidates, { keepTopK: 2 })
		expect(result.map((d) => d.drawerId)).toEqual(['a', 'b'])
	})
})

test.describe('memory/mining — extractor model id', () => {
	let releaseBudgetLock: (() => Promise<void>) | null = null
	let stub: OpenRouterStub | null = null
	let startedAt = new Date()
	let prefix = ''
	test.beforeEach(async () => {
		releaseBudgetLock = await acquireGlobalStateLock('budget-state')
		startedAt = new Date()
		prefix = uniquePrefix('mine-extractor-model')
	})
	test.afterEach(async () => {
		stub?.restore()
		stub = null
		const sql = getSql()
		// Rooms, closets and drawers cascade from the wing.
		await sql`delete from memory_wings where name like ${`${prefix}%`}`
		await sql`
			delete from llm_usage
			where source in ('memory_extract', 'memory_embed') and created_at >= ${startedAt}
		`
		await releaseBudgetLock?.()
		releaseBudgetLock = null
	})

	const session = (label: string) => ({
		conversationId: null,
		occurredAt: new Date(),
		sessionLabel: label,
		turns: [
			{ role: 'user' as const, content: 'We picked the 48V battery for the van build.' },
			{ role: 'assistant' as const, content: 'Noted: 48V battery for the van.' },
		],
	})

	test('the extractor is called with an OpenRouter slug and its answer files the turns', async () => {
		stub = stubOpenRouter({
			chat: () =>
				JSON.stringify({
					primaryWing: { kind: 'project', name: `${prefix} van build`, aliases: [] },
					turns: [
						{ topic: 'battery', tags: { i: ['48V battery'] } },
						{ topic: 'battery', tags: {} },
					],
				}),
		})
		const userId = await getActiveUserId()
		const { mineSession } = await import('../src/lib/memory/mining.server')
		const { DEFAULT_MODEL } = await import('../src/lib/llm/chat.server')

		const result = await mineSession({ userId, session: session(`${prefix} chat`) })

		const [extractorCall] = stub.callsTo('/chat/completions')
		expect(extractorCall.body?.model).toBe(toOpenRouterModelId(DEFAULT_MODEL))
		expect(String(extractorCall.body?.model)).toMatch(/^anthropic\//)
		expect(result.extractorFallback).toBe(false)
		expect(result.drawerIds).toHaveLength(2)

		const [wing] = await getSql()<{ name: string; kind: string }[]>`
			select name, kind::text as kind from memory_wings where id = ${result.wingIds[0]}
		`
		expect(wing).toEqual({ name: `${prefix} van build`, kind: 'project' })
	})

	test('a failed extractor call still mines, and says it fell back', async () => {
		stub = stubOpenRouter({ chat: (body) => invalidModelResponse(String(body.model)) })
		const userId = await getActiveUserId()
		const { mineSession } = await import('../src/lib/memory/mining.server')

		const result = await mineSession({ userId, session: session(`${prefix} fallback chat`) })

		expect(result.extractorFallback).toBe(true)
		expect(result.drawerIds).toHaveLength(2)
		const [wing] = await getSql()<{ name: string }[]>`select name from memory_wings where id = ${result.wingIds[0]}`
		expect(wing.name, 'the fallback wing is named after the conversation').toBe(`${prefix} fallback chat`)
	})

	test('the mining job reports a fallback in its result', async () => {
		const { executeMemoryMineJob } = await import('../src/lib/memory/memory-handler.server')
		const job = { id: '00000000-0000-0000-0000-000000000000', dedupeKey: null, payload: { conversationId: crypto.randomUUID() } }
		const result = await executeMemoryMineJob(job, async () => ({
			drawerIds: ['d'],
			wingIds: ['w'],
			roomIds: ['r'],
			closetIds: ['c'],
			excludedTurns: 0,
			timedOutTurns: 0,
			excludedByRule: [],
			extractorFallback: true,
		}))
		expect(result.extractorFallback).toBe(true)
	})
})
