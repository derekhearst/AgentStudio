/**
 * The engine model pickers offer only what can run (#9).
 *
 * Pure — no database, no server.
 *
 * The chat composer, the agent editor and the default-model setting used to list OpenRouter's
 * whole catalogue. Without a gateway every non-Claude row failed on the first message, and a
 * Claude row stored OpenRouter's dotted spelling, which the CLI does not know. The list is now
 * built from the backends that exist on this deployment: the Claude models the CLI can run,
 * and — with a gateway — the gateway's models that can take the CLI's tools.
 */

import { expect, test } from '@playwright/test'
import {
	buildEngineModelList,
	claudeDisplayName,
	DEFAULT_CONTEXT_LIMIT,
	engineContextLimit,
	findEngineModel,
	parseGatewayModelIds,
} from '../src/lib/llm/engine-models'
import { SUBSCRIPTION_MODEL_IDS } from '../src/lib/engine/model-backend'
import { getCreator } from '../src/lib/llm/model-filters'
import type { ModelInfo } from '../src/lib/llm/models.server'

function model(
	id: string,
	name: string,
	options: { prompt?: string; completion?: string; tools?: boolean; output?: string[] } = {},
): ModelInfo {
	return {
		id,
		name,
		contextLength: 200_000,
		promptPrice: options.prompt ?? '0.000003',
		completionPrice: options.completion ?? '0.000015',
		inputModalities: ['text', 'image'],
		outputModalities: options.output ?? ['text'],
		supportedParameters: options.tools === false ? ['temperature', 'max_tokens'] : ['tools', 'tool_choice', 'temperature'],
	}
}

const CATALOGUE: ModelInfo[] = [
	model('anthropic/claude-haiku-4.5', 'Anthropic: Claude Haiku 4.5'),
	model('anthropic/claude-sonnet-5', 'Anthropic: Claude Sonnet 5'),
	model('anthropic/claude-3.7-sonnet:thinking', 'Anthropic: Claude 3.7 Sonnet (thinking)'),
	model('moonshotai/kimi-k2', 'MoonshotAI: Kimi K2', { prompt: '0.0000006', completion: '0.0000025' }),
	model('openai/gpt-5', 'OpenAI: GPT-5'),
	model('openai/whisper', 'OpenAI: Whisper'),
]

/** Claude rows OpenRouter's live catalogue still carries that the CLI cannot run. */
const UNRUNNABLE_CLAUDE: ModelInfo[] = [
	model('anthropic/claude-sonnet-4', 'Anthropic: Claude Sonnet 4'),
	model('anthropic/claude-opus-4', 'Anthropic: Claude Opus 4'),
	model('anthropic/claude-3-haiku', 'Anthropic: Claude 3 Haiku'),
	model('anthropic/claude-3.5-haiku', 'Anthropic: Claude 3.5 Haiku'),
	model('anthropic/claude-3.7-sonnet', 'Anthropic: Claude 3.7 Sonnet'),
	model('anthropic/claude-opus-4.1', 'Anthropic: Claude Opus 4.1'),
]

test.describe('without a gateway', () => {
	const list = buildEngineModelList({ catalogue: CATALOGUE, gatewayConfigured: false, gatewayModelIds: null })
	const byId = new Map(list.map((m) => [m.id, m]))

	test('exactly the Claude models the CLI can run are offered, in its spelling, on the subscription', () => {
		expect(new Set(list.map((m) => m.id))).toEqual(new Set(SUBSCRIPTION_MODEL_IDS))
		for (const m of list) {
			expect(m.backend, m.id).toBe('subscription')
			expect(m.priced, m.id).toBe(true)
		}
	})

	test('the catalogue describes the models it lists, under the same name either way', () => {
		expect(byId.get('claude-haiku-4-5')).toMatchObject({ name: 'Claude Haiku 4.5', contextLength: 200_000 })
		// Not in this catalogue, but it runs on the subscription all the same.
		expect(byId.get('claude-fable-5-1')).toMatchObject({
			name: 'Claude Fable 5.1',
			contextLength: null,
			inputModalities: ['text', 'image', 'file'],
			outputModalities: ['text'],
		})
	})

	test('a catalogue variant is not a model the CLI can be asked for', () => {
		expect(list.some((m) => m.id.includes(':'))).toBe(false)
	})

	test('a Claude slug the CLI cannot run is never offered, whatever the catalogue says', () => {
		const withStale = buildEngineModelList({
			catalogue: [...CATALOGUE, ...UNRUNNABLE_CLAUDE],
			gatewayConfigured: false,
			gatewayModelIds: null,
		})
		const ids = withStale.map((m) => m.id)
		expect(new Set(ids)).toEqual(new Set(SUBSCRIPTION_MODEL_IDS))
		for (const stale of ['claude-sonnet-4', 'claude-opus-4', 'claude-3-haiku', 'claude-3-5-haiku', 'claude-3-7-sonnet', 'claude-opus-4-1']) {
			expect(ids, stale).not.toContain(stale)
		}
	})

	test('an unreachable catalogue still leaves every subscription model to pick', () => {
		const offline = buildEngineModelList({ catalogue: [], gatewayConfigured: false, gatewayModelIds: null })
		expect(new Set(offline.map((m) => m.id))).toEqual(new Set(SUBSCRIPTION_MODEL_IDS))
	})

	test('a pinned default is kept when nothing else lists it, and dropped when nothing can run it', () => {
		const pinned = buildEngineModelList({
			catalogue: [],
			gatewayConfigured: false,
			gatewayModelIds: null,
			pinned: ['claude-sonnet-4-5[1m]', 'anthropic/claude-opus-4.1', 'anthropic/claude-sonnet-4', 'moonshotai/kimi-k2'],
		})
		expect(pinned.find((m) => m.id === 'claude-sonnet-4-5[1m]')).toMatchObject({ backend: 'subscription' })
		const ids = pinned.map((m) => m.id)
		for (const dropped of ['claude-opus-4-1', 'claude-sonnet-4', 'moonshotai/kimi-k2']) {
			expect(ids, dropped).not.toContain(dropped)
		}
	})

	test('a pinned id already on the list is not listed twice', () => {
		const pinned = buildEngineModelList({
			catalogue: CATALOGUE,
			gatewayConfigured: false,
			gatewayModelIds: null,
			pinned: ['anthropic/claude-sonnet-5'],
		})
		expect(pinned.filter((m) => m.id === 'claude-sonnet-5')).toHaveLength(1)
		expect(pinned.find((m) => m.id === 'claude-sonnet-5')?.name).toBe('Claude Sonnet 5')
	})
})

test.describe('with a gateway', () => {
	const catalogue: ModelInfo[] = [
		...CATALOGUE,
		// OpenRouter lists these, but the CLI sends tools on every request and reads text back.
		model('tencent/hy-mt2-7b', 'Tencent: Hunyuan MT', { tools: false }),
		model('google/gemini-3.1-flash-image', 'Google: Gemini 3.1 Flash Image', { output: ['image'] }),
		...UNRUNNABLE_CLAUDE,
	]
	const list = buildEngineModelList({
		catalogue,
		gatewayConfigured: true,
		// What the gateway says it serves: catalogue models, a model only it knows, and Claude.
		gatewayModelIds: [
			'moonshotai/kimi-k2',
			'ollama/qwen3-coder',
			'anthropic/claude-sonnet-5',
			'anthropic/claude-sonnet-4',
			'tencent/hy-mt2-7b',
			'google/gemini-3.1-flash-image',
		],
	})
	const byId = new Map(list.map((m) => [m.id, m]))

	test('the gateway’s own models are offered, labelled as gateway', () => {
		expect(byId.get('moonshotai/kimi-k2')).toMatchObject({ backend: 'gateway', priced: true, promptPrice: '0.0000006' })
		expect(byId.get('ollama/qwen3-coder')).toMatchObject({ backend: 'gateway', priced: false, name: 'ollama/qwen3-coder' })
	})

	test('a catalogued gateway model that cannot take tools or answer in text is not offered', () => {
		expect(byId.has('tencent/hy-mt2-7b')).toBe(false)
		expect(byId.has('google/gemini-3.1-flash-image')).toBe(false)
	})

	test('a catalogue model the gateway does not serve is not offered', () => {
		expect(byId.has('openai/gpt-5')).toBe(false)
	})

	test('Claude stays on the subscription even when the gateway also serves it', () => {
		expect(byId.get('claude-sonnet-5')?.backend).toBe('subscription')
		expect(byId.has('anthropic/claude-sonnet-5')).toBe(false)
		// Nor does the gateway become a way in for a Claude id the CLI cannot run.
		expect(byId.has('anthropic/claude-sonnet-4')).toBe(false)
		expect(byId.has('claude-sonnet-4')).toBe(false)
	})

	test('a CLI alias is Claude too: pinned, it is a subscription row, and the gateway never gets it', () => {
		const aliases = buildEngineModelList({
			catalogue: [],
			gatewayConfigured: true,
			gatewayModelIds: ['fable', 'best'],
			pinned: ['fable', 'best'],
		})
		for (const alias of ['fable', 'best']) {
			expect(aliases.filter((m) => m.id === alias), alias).toEqual([expect.objectContaining({ backend: 'subscription' })])
		}
		expect(aliases.some((m) => m.backend === 'gateway')).toBe(false)
	})

	test('a gateway that could not be asked contributes nothing, rather than a guess', () => {
		const unknown = buildEngineModelList({ catalogue: CATALOGUE, gatewayConfigured: true, gatewayModelIds: null })
		expect(unknown.every((m) => m.backend === 'subscription')).toBe(true)
	})

	test('a pinned gateway model can be picked again, unless the catalogue says it cannot run', () => {
		const pinned = buildEngineModelList({
			catalogue: [],
			gatewayConfigured: true,
			gatewayModelIds: [],
			pinned: ['moonshotai/kimi-k2'],
		})
		expect(pinned.find((m) => m.id === 'moonshotai/kimi-k2')).toMatchObject({ backend: 'gateway', priced: false })

		const toolless = buildEngineModelList({
			catalogue,
			gatewayConfigured: true,
			gatewayModelIds: [],
			pinned: ['tencent/hy-mt2-7b'],
		})
		expect(toolless.some((m) => m.id === 'tencent/hy-mt2-7b')).toBe(false)
	})
})

test('claudeDisplayName writes the CLI id the way Anthropic names the model', () => {
	expect(claudeDisplayName('claude-haiku-4-5')).toBe('Claude Haiku 4.5')
	expect(claudeDisplayName('claude-fable-5-1')).toBe('Claude Fable 5.1')
	expect(claudeDisplayName('claude-opus-5')).toBe('Claude Opus 5')
	expect(claudeDisplayName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
})

test('findEngineModel matches a stored id however it is spelled', () => {
	const list = buildEngineModelList({ catalogue: CATALOGUE, gatewayConfigured: false, gatewayModelIds: null })
	expect(findEngineModel(list, 'anthropic/claude-haiku-4.5')?.id).toBe('claude-haiku-4-5')
	expect(findEngineModel(list, 'claude-haiku-4-5')?.id).toBe('claude-haiku-4-5')
	expect(findEngineModel(list, 'moonshotai/kimi-k2')).toBeUndefined()
})

test.describe('engineContextLimit — the chat page’s context window', () => {
	const catalogue: ModelInfo[] = [
		{ ...model('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5'), contextLength: 1_000_000 },
		{ ...model('moonshotai/kimi-k2', 'MoonshotAI: Kimi K2'), contextLength: 262_144 },
	]
	const list = buildEngineModelList({ catalogue, gatewayConfigured: true, gatewayModelIds: ['moonshotai/kimi-k2'] })

	test('a Claude model picked in the composer reads its real window, not the fallback', () => {
		// The composer stores the CLI id, which the OpenRouter catalogue does not list: looked up
		// there, every Claude pick read as 128K.
		expect(catalogue.find((m) => m.id === 'claude-sonnet-4-5')).toBeUndefined()
		expect(engineContextLimit(list, 'claude-sonnet-4-5')).toBe(1_000_000)
	})

	test('an older conversation stored under OpenRouter’s spelling reads the same window', () => {
		// So switching it to the composer's spelling is not a move to a smaller window, which
		// the page answers with an automatic compaction turn.
		expect(engineContextLimit(list, 'anthropic/claude-sonnet-4.5')).toBe(engineContextLimit(list, 'claude-sonnet-4-5'))
	})

	test('a gateway model reads the catalogue’s window under its own id', () => {
		expect(engineContextLimit(list, 'moonshotai/kimi-k2')).toBe(262_144)
	})

	test('a model no list describes falls back to 128K', () => {
		expect(DEFAULT_CONTEXT_LIMIT).toBe(128_000)
		expect(engineContextLimit(list, 'anthropic/claude-sonnet-4')).toBe(DEFAULT_CONTEXT_LIMIT)
		// Listed, but the catalogue could not describe it.
		expect(engineContextLimit(list, 'claude-fable-5-1')).toBe(DEFAULT_CONTEXT_LIMIT)
		expect(engineContextLimit([], 'claude-sonnet-4-5')).toBe(DEFAULT_CONTEXT_LIMIT)
	})
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
