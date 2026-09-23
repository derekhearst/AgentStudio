import { expect, test } from '@playwright/test'

/**
 * Every direct OpenRouter call sends the id OpenRouter's catalogue actually has.
 *
 * Research, memory mining, reranking and the legacy runtime loop all call OpenRouter, and
 * since the engine migration their defaults are stored the SDK's way (`claude-sonnet-5`).
 * OpenRouter only knows `anthropic/claude-sonnet-5`, so every research planner call was a
 * 400 and the ledger priced the rest at nothing. The current models' ids on the right below
 * are the ones OpenRouter's public `/models` listed on 2026-09-23.
 */

test.describe('llm/model-ids — OpenRouter spelling', () => {
	test('bare SDK ids gain the vendor prefix and a dotted version', async () => {
		const { toOpenRouterModelId } = await import('../src/lib/llm/model-ids')
		expect(toOpenRouterModelId('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
		expect(toOpenRouterModelId('claude-opus-5')).toBe('anthropic/claude-opus-5')
		expect(toOpenRouterModelId('claude-opus-5-5')).toBe('anthropic/claude-opus-5.5')
		expect(toOpenRouterModelId('claude-haiku-4-5')).toBe('anthropic/claude-haiku-4.5')
		expect(toOpenRouterModelId('claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4.6')
	})

	test('SDK snapshot dates and context-window markers are dropped', async () => {
		const { toOpenRouterModelId } = await import('../src/lib/llm/model-ids')
		expect(toOpenRouterModelId('claude-sonnet-4-5-20250929')).toBe('anthropic/claude-sonnet-4.5')
		expect(toOpenRouterModelId('claude-sonnet-5[1m]')).toBe('anthropic/claude-sonnet-5')
		expect(toOpenRouterModelId('claude-3-5-haiku-20241022')).toBe('anthropic/claude-3.5-haiku')
		expect(toOpenRouterModelId('claude-3-haiku')).toBe('anthropic/claude-3-haiku')
	})

	test('ids already in OpenRouter form are left alone, and SDK-style anthropic ids are fixed', async () => {
		const { toOpenRouterModelId } = await import('../src/lib/llm/model-ids')
		expect(toOpenRouterModelId('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5')
		expect(toOpenRouterModelId('anthropic/claude-sonnet-5:batch')).toBe('anthropic/claude-sonnet-5:batch')
		expect(toOpenRouterModelId('anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4.6')
		expect(toOpenRouterModelId('openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini')
		expect(toOpenRouterModelId('moonshotai/kimi-k2-0905')).toBe('moonshotai/kimi-k2-0905')
		expect(toOpenRouterModelId('google/gemini-2.5-flash')).toBe('google/gemini-2.5-flash')
	})

	test('an alias that names no specific model is not guessed at', async () => {
		const { toOpenRouterModelId } = await import('../src/lib/llm/model-ids')
		expect(toOpenRouterModelId('sonnet')).toBe('sonnet')
		expect(toOpenRouterModelId('  claude-sonnet-5  ')).toBe('anthropic/claude-sonnet-5')
		expect(toOpenRouterModelId('')).toBe('')
	})

	test('the defaults research and memory mining fall back to map to catalogue ids', async () => {
		const { toOpenRouterModelId } = await import('../src/lib/llm/model-ids')
		const { DEFAULT_RESEARCH_CONFIG } = await import('../src/lib/research/research-config')
		expect(toOpenRouterModelId(DEFAULT_RESEARCH_CONFIG.plannerModel)).toBe('anthropic/claude-sonnet-5')
		expect(toOpenRouterModelId(DEFAULT_RESEARCH_CONFIG.synthesizerModel)).toBe('anthropic/claude-sonnet-5')
	})

	test('chat() puts the OpenRouter id on the wire, not the stored one', async () => {
		const { chat } = await import('../src/lib/llm/chat.server')
		const realFetch = globalThis.fetch
		const realKey = process.env.OPENROUTER_API_KEY
		let sentModel: unknown = null
		// The cache path is the one that goes through `fetch`, which is what makes the request
		// observable here without a network.
		globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
			sentModel = JSON.parse(String(init?.body ?? '{}')).model
			return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}) as typeof fetch
		process.env.OPENROUTER_API_KEY = 'sk-test-not-a-real-key'
		try {
			const result = await chat([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', { cache: { enabled: true } })
			expect(result.content).toBe('ok')
			expect(sentModel).toBe('anthropic/claude-sonnet-5')
		} finally {
			globalThis.fetch = realFetch
			if (realKey === undefined) delete process.env.OPENROUTER_API_KEY
			else process.env.OPENROUTER_API_KEY = realKey
		}
	})
})
