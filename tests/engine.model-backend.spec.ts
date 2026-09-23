/**
 * Which backend runs a model, and the id the engine sends for it (#9).
 *
 * Pure — no database, no server.
 *
 * Claude runs on the subscription; anything else needs the gateway, and with no gateway it is
 * unavailable. The picker, the stream route and the engine all read these rules, so a model
 * the picker offers is one the route accepts and the engine can start.
 */

import { expect, test } from '@playwright/test'
import {
	gatewayNotConfiguredMessage,
	isClaudeModel,
	modelBackend,
	normalizeModelId,
} from '../src/lib/engine/model-backend'

test.describe('normalizeModelId', () => {
	const cases: Array<[string, string]> = [
		// OpenRouter's catalogue spelling becomes the CLI's: prefix gone, dotted version dashed.
		['anthropic/claude-haiku-4.5', 'claude-haiku-4-5'],
		['anthropic/claude-opus-4.1', 'claude-opus-4-1'],
		['anthropic/claude-3.7-sonnet', 'claude-3-7-sonnet'],
		['anthropic/claude-sonnet-4', 'claude-sonnet-4'],
		['anthropic/claude-sonnet-5', 'claude-sonnet-5'],
		// A bare dotted id is the same mistake without the prefix.
		['claude-haiku-4.5', 'claude-haiku-4-5'],
		['claude-sonnet-4.5[1m]', 'claude-sonnet-4-5[1m]'],
		// Already the CLI's spelling: unchanged.
		['claude-sonnet-5', 'claude-sonnet-5'],
		['claude-haiku-4-5', 'claude-haiku-4-5'],
		['claude-opus-4-1-20250805', 'claude-opus-4-1-20250805'],
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

test.describe('modelBackend', () => {
	test('Claude is always on the subscription, gateway or not', () => {
		expect(modelBackend('claude-sonnet-5', { gatewayConfigured: false })).toBe('subscription')
		expect(modelBackend('anthropic/claude-haiku-4.5', { gatewayConfigured: true })).toBe('subscription')
	})

	test('a non-Claude model needs the gateway, and is unavailable without one', () => {
		expect(modelBackend('moonshotai/kimi-k2', { gatewayConfigured: true })).toBe('gateway')
		expect(modelBackend('moonshotai/kimi-k2', { gatewayConfigured: false })).toBe('unavailable')
	})

	test('the refusal names the model and the two settings that would fix it', () => {
		const message = gatewayNotConfiguredMessage('moonshotai/kimi-k2')
		expect(message).toContain('moonshotai/kimi-k2')
		expect(message).toContain('LLM_GATEWAY_URL')
		expect(message).toContain('LLM_GATEWAY_TOKEN')
	})
})
