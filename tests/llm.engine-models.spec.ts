/**
 * The engine model pickers offer only what can run (#9).
 *
 * Pure — no database, no server.
 *
 * The chat composer, the agent editor and the default-model setting used to list OpenRouter's
 * whole catalogue. Without a gateway every non-Claude row failed on the first message, and a
 * Claude row stored OpenRouter's dotted spelling, which the CLI does not know. The list is now
 * built from the backends that exist on this deployment.
 */

import { expect, test } from '@playwright/test'
import { buildEngineModelList, findEngineModel, parseGatewayModelIds } from '../src/lib/llm/engine-models'
import { getCreator } from '../src/lib/llm/model-filters'
import type { ModelInfo } from '../src/lib/llm/models.server'

function model(id: string, name: string, prompt = '0.000003', completion = '0.000015'): ModelInfo {
	return { id, name, contextLength: 200_000, promptPrice: prompt, completionPrice: completion }
}

const CATALOGUE: ModelInfo[] = [
	model('anthropic/claude-haiku-4.5', 'Anthropic: Claude Haiku 4.5'),
	model('anthropic/claude-sonnet-5', 'Anthropic: Claude Sonnet 5'),
	model('anthropic/claude-3.7-sonnet:thinking', 'Anthropic: Claude 3.7 Sonnet (thinking)'),
	model('moonshotai/kimi-k2', 'MoonshotAI: Kimi K2', '0.0000006', '0.0000025'),
	model('openai/gpt-5', 'OpenAI: GPT-5'),
	model('openai/whisper', 'OpenAI: Whisper'),
]

test.describe('without a gateway', () => {
	const list = buildEngineModelList({ catalogue: CATALOGUE, gatewayConfigured: false, gatewayModelIds: null })

	test('only Claude is offered, in the CLI’s spelling, on the subscription', () => {
		expect(list.map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5'])
		for (const m of list) {
			expect(m.backend).toBe('subscription')
			expect(m.priced).toBe(true)
		}
		// The catalogue's name and context come along.
		expect(list[0].name).toBe('Anthropic: Claude Haiku 4.5')
		expect(list[0].contextLength).toBe(200_000)
	})

	test('a catalogue variant is not a model the CLI can be asked for', () => {
		expect(list.some((m) => m.id.includes(':'))).toBe(false)
	})

	test('a pinned default is kept when the catalogue lacks it, and dropped when nothing can run it', () => {
		const pinned = buildEngineModelList({
			catalogue: [],
			gatewayConfigured: false,
			gatewayModelIds: null,
			pinned: ['anthropic/claude-opus-4.1', 'moonshotai/kimi-k2'],
		})
		expect(pinned.map((m) => [m.id, m.backend])).toEqual([['claude-opus-4-1', 'subscription']])
	})

	test('a pinned id the catalogue already lists is not listed twice', () => {
		const pinned = buildEngineModelList({
			catalogue: CATALOGUE,
			gatewayConfigured: false,
			gatewayModelIds: null,
			pinned: ['claude-sonnet-5'],
		})
		expect(pinned.filter((m) => m.id === 'claude-sonnet-5')).toHaveLength(1)
		expect(pinned.find((m) => m.id === 'claude-sonnet-5')?.name).toBe('Anthropic: Claude Sonnet 5')
	})
})

test.describe('with a gateway', () => {
	const list = buildEngineModelList({
		catalogue: CATALOGUE,
		gatewayConfigured: true,
		// What the gateway says it serves: a catalogue model, a model only it knows, and Claude.
		gatewayModelIds: ['moonshotai/kimi-k2', 'ollama/qwen3-coder', 'anthropic/claude-sonnet-5'],
	})
	const byId = new Map(list.map((m) => [m.id, m]))

	test('the gateway’s own models are offered, labelled as gateway', () => {
		expect(byId.get('moonshotai/kimi-k2')).toMatchObject({ backend: 'gateway', priced: true, promptPrice: '0.0000006' })
		expect(byId.get('ollama/qwen3-coder')).toMatchObject({ backend: 'gateway', priced: false, name: 'ollama/qwen3-coder' })
	})

	test('a catalogue model the gateway does not serve is not offered', () => {
		expect(byId.has('openai/gpt-5')).toBe(false)
	})

	test('Claude stays on the subscription even when the gateway also serves it', () => {
		expect(byId.get('claude-sonnet-5')?.backend).toBe('subscription')
		expect(byId.has('anthropic/claude-sonnet-5')).toBe(false)
	})

	test('a gateway that could not be asked contributes nothing, rather than a guess', () => {
		const unknown = buildEngineModelList({ catalogue: CATALOGUE, gatewayConfigured: true, gatewayModelIds: null })
		expect(unknown.every((m) => m.backend === 'subscription')).toBe(true)
	})

	test('a pinned gateway model can be picked again', () => {
		const pinned = buildEngineModelList({
			catalogue: [],
			gatewayConfigured: true,
			gatewayModelIds: [],
			pinned: ['moonshotai/kimi-k2'],
		})
		expect(pinned).toMatchObject([{ id: 'moonshotai/kimi-k2', backend: 'gateway', priced: false }])
	})
})

test('findEngineModel matches a stored id however it is spelled', () => {
	const list = buildEngineModelList({ catalogue: CATALOGUE, gatewayConfigured: false, gatewayModelIds: null })
	expect(findEngineModel(list, 'anthropic/claude-haiku-4.5')?.id).toBe('claude-haiku-4-5')
	expect(findEngineModel(list, 'claude-haiku-4-5')?.id).toBe('claude-haiku-4-5')
	expect(findEngineModel(list, 'moonshotai/kimi-k2')).toBeUndefined()
})

test('parseGatewayModelIds reads OpenAI-style lists and skips anything malformed', () => {
	expect(parseGatewayModelIds({ data: [{ id: 'a/b' }, { id: ' c/d ' }, { id: 'a/b' }, { id: 7 }, null, {}] })).toEqual([
		'a/b',
		'c/d',
	])
	expect(parseGatewayModelIds({})).toEqual([])
	expect(parseGatewayModelIds(null)).toEqual([])
	expect(parseGatewayModelIds({ data: 'nope' })).toEqual([])
})

test('a bare Claude id is grouped under Anthropic', () => {
	expect(getCreator('claude-sonnet-5')).toBe('anthropic')
	expect(getCreator('anthropic/claude-sonnet-5')).toBe('anthropic')
	expect(getCreator('moonshotai/kimi-k2')).toBe('moonshotai')
	expect(getCreator('local-model')).toBe('unknown')
})
