/**
 * Which backend runs a model, and the id the engine sends for it (#9).
 *
 * Pure — no database, no server.
 *
 * Claude runs on the subscription, but only a Claude model the bundled CLI can run; anything
 * else needs the gateway, and with no gateway it is unavailable. The picker, the stream route,
 * the saves and the engine all read these rules, so a model the picker offers is one the route
 * accepts and the engine can start.
 */

import { expect, test } from '@playwright/test'
import {
	gatewayNotConfiguredMessage,
	isClaudeModel,
	isSubscriptionModel,
	modelBackend,
	normalizeModelId,
	SUBSCRIPTION_MODEL_IDS,
	unrunnableModelMessage,
} from '../src/lib/engine/model-backend'

test.describe('normalizeModelId', () => {
	// Spelling only: the prefix goes and a dotted version is dashed. Whether the result is a
	// model the CLI can run is `isSubscriptionModel`'s question, below.
	const cases: Array<[string, string]> = [
		['anthropic/claude-haiku-4.5', 'claude-haiku-4-5'],
		['anthropic/claude-opus-4.8', 'claude-opus-4-8'],
		['anthropic/claude-fable-5.1', 'claude-fable-5-1'],
		['anthropic/claude-sonnet-5', 'claude-sonnet-5'],
		// A bare dotted id is the same mistake without the prefix.
		['claude-haiku-4.5', 'claude-haiku-4-5'],
		['claude-sonnet-4.5[1m]', 'claude-sonnet-4-5[1m]'],
		// Already the CLI's spelling: unchanged.
		['claude-sonnet-5', 'claude-sonnet-5'],
		['claude-haiku-4-5', 'claude-haiku-4-5'],
		['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
		['opus', 'opus'],
		// A gateway id is the gateway's to read, dots and all.
		['moonshotai/kimi-k2', 'moonshotai/kimi-k2'],
		['openai/gpt-4.1', 'openai/gpt-4.1'],
		['z-ai/glm-4.6', 'z-ai/glm-4.6'],
	]
	for (const [input, expected] of cases) {
		test(`${input} → ${expected}`, () => {
			expect(normalizeModelId(input)).toBe(expected)
		})
	}

	test('surrounding whitespace is not part of an id', () => {
		expect(normalizeModelId('  anthropic/claude-haiku-4.5 ')).toBe('claude-haiku-4-5')
	})
})

test.describe('isClaudeModel', () => {
	test('Claude ids in either spelling, and the CLI aliases', () => {
		for (const id of ['claude-sonnet-5', 'anthropic/claude-haiku-4.5', 'ANTHROPIC/claude-opus-4.1', 'opus', 'sonnet', 'haiku']) {
			expect(isClaudeModel(id), id).toBe(true)
		}
	})

	test('everything else, including a vendor that merely hosts Claude-like names', () => {
		for (const id of ['moonshotai/kimi-k2', 'openai/gpt-5', 'deepseek/deepseek-chat', 'someone/claude-clone']) {
			expect(isClaudeModel(id), id).toBe(false)
		}
	})
})

test.describe('isSubscriptionModel', () => {
	test('every listed model, in the CLI’s spelling and OpenRouter’s', () => {
		for (const id of SUBSCRIPTION_MODEL_IDS) {
			expect(isSubscriptionModel(id), id).toBe(true)
			expect(isSubscriptionModel(`anthropic/${id.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`), `anthropic/… ${id}`).toBe(true)
		}
	})

	test('the snapshot ids and aliases the CLI takes, with or without [1m]', () => {
		for (const id of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'claude-sonnet-4-5[1m]']) {
			expect(isSubscriptionModel(id), id).toBe(true)
		}
	})

	test('a catalogue slug that is no Anthropic id, and retired models, are not runnable', () => {
		for (const id of [
			// OpenRouter still lists these; normalised, they are not ids the CLI or the API know.
			'anthropic/claude-sonnet-4',
			'anthropic/claude-opus-4',
			'anthropic/claude-3-haiku',
			'claude-sonnet-4',
			'claude-3-haiku',
			// Real ids the CLI's table dates as retired on Anthropic's API.
			'claude-sonnet-4-0',
			'claude-sonnet-4-20250514',
			'claude-opus-4-0',
			'claude-opus-4-1',
			'anthropic/claude-opus-4.1',
			'claude-3-7-sonnet',
			'anthropic/claude-3.5-haiku',
			// Not an id at all.
			'claude-haiku-5',
		]) {
			expect(isSubscriptionModel(id), id).toBe(false)
		}
	})

	test('only Claude: a gateway model is never a subscription model', () => {
		expect(isSubscriptionModel('moonshotai/kimi-k2')).toBe(false)
	})
})

test.describe('modelBackend', () => {
	test('a Claude model the CLI runs is on the subscription, gateway or not', () => {
		expect(modelBackend('claude-sonnet-5', { gatewayConfigured: false })).toBe('subscription')
		expect(modelBackend('anthropic/claude-haiku-4.5', { gatewayConfigured: true })).toBe('subscription')
	})

	test('a non-Claude model needs the gateway, and is unavailable without one', () => {
		expect(modelBackend('moonshotai/kimi-k2', { gatewayConfigured: true })).toBe('gateway')
		expect(modelBackend('moonshotai/kimi-k2', { gatewayConfigured: false })).toBe('unavailable')
	})

	test('a Claude id the CLI cannot run is unavailable, and never sent to the paid gateway', () => {
		for (const gatewayConfigured of [false, true]) {
			expect(modelBackend('anthropic/claude-sonnet-4', { gatewayConfigured })).toBe('unavailable')
			expect(modelBackend('claude-3-haiku', { gatewayConfigured })).toBe('unavailable')
		}
	})

	test('the gateway refusal names the model and the two settings that would fix it', () => {
		const message = gatewayNotConfiguredMessage('moonshotai/kimi-k2')
		expect(message).toContain('moonshotai/kimi-k2')
		expect(message).toContain('LLM_GATEWAY_URL')
		expect(message).toContain('LLM_GATEWAY_TOKEN')
		expect(unrunnableModelMessage('moonshotai/kimi-k2')).toBe(message)
	})

	test('an unrunnable Claude id is refused for what it is, not for a missing gateway', () => {
		const message = unrunnableModelMessage('anthropic/claude-sonnet-4')
		expect(message).toContain('anthropic/claude-sonnet-4')
		expect(message).toContain('retired')
		expect(message).not.toContain('LLM_GATEWAY')
	})
})
