/**
 * A gateway run's environment and its cost (#9).
 *
 * Pure — no database, no server.
 *
 * The environment: OpenRouter's Claude Code and Agent SDK guides both say a gateway run needs
 * `ANTHROPIC_BASE_URL`, the key as `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` explicitly
 * empty. Every model class the CLI reads is pinned to the chosen model, or its helper and
 * subagent calls ask the gateway for a Claude model — a paid Claude call on OpenRouter, a
 * refusal on a gateway without one. The subscription login is not handed to a paid run.
 *
 * The cost: the SDK prices a model it has no row for as "a guess at the default model's rate",
 * so a gateway turn is priced from the OpenRouter catalogue over the turn's own tokens.
 */

import { expect, test } from '@playwright/test'
import { buildGatewayEnv, GATEWAY_MODEL_ENV_NAMES, readGatewayConfig } from '../src/lib/engine/gateway-env'
import { engineAuthEnvNames } from '../src/lib/engine/engine-env'
import { gatewayTurnCost, ledgerCostOverride } from '../src/lib/engine/gateway-cost'

const SERVER_ENV: Record<string, string> = {
	PATH: '/usr/bin',
	HOME: '/data',
	CLAUDE_CONFIG_DIR: '/data/.claude',
	CLAUDE_CODE_OAUTH_TOKEN: 'subscription-login',
	DATABASE_URL: 'postgres://user:pw@db/app',
	OPENROUTER_API_KEY: 'o',
	LLM_GATEWAY_URL: 'https://openrouter.ai/api',
	LLM_GATEWAY_TOKEN: 'gw-token',
	// Inherited ANTHROPIC_* must never reach a gateway run: the gateway's are set explicitly.
	ANTHROPIC_API_KEY: 'sk-ant-inherited',
	ANTHROPIC_BASE_URL: 'https://elsewhere',
	ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
	ANTHROPIC_CUSTOM_HEADERS: 'x-leak: 1',
}

const GATEWAY = { baseUrl: 'https://openrouter.ai/api', token: 'gw-token' }

test.describe('buildGatewayEnv', () => {
	const env = buildGatewayEnv({ model: 'moonshotai/kimi-k2', gateway: GATEWAY, source: SERVER_ENV })

	test('points the CLI at the gateway with a bearer token and a blank API key', () => {
		expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api')
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gw-token')
		expect(env.ANTHROPIC_API_KEY).toBe('')
	})

	test('pins every model class to the chosen model', () => {
		expect(GATEWAY_MODEL_ENV_NAMES).toEqual(
			expect.arrayContaining([
				'ANTHROPIC_MODEL',
				'ANTHROPIC_DEFAULT_OPUS_MODEL',
				'ANTHROPIC_DEFAULT_SONNET_MODEL',
				'ANTHROPIC_DEFAULT_HAIKU_MODEL',
				'ANTHROPIC_DEFAULT_FABLE_MODEL',
				'CLAUDE_CODE_SUBAGENT_MODEL',
			]),
		)
		for (const name of GATEWAY_MODEL_ENV_NAMES) expect(env[name], name).toBe('moonshotai/kimi-k2')
	})

	test('the only ANTHROPIC_* variables are the gateway’s own', () => {
		const anthropic = Object.keys(env)
			.filter((name) => name.startsWith('ANTHROPIC_'))
			.sort()
		const expected = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', ...GATEWAY_MODEL_ENV_NAMES]
			.filter((name) => name.startsWith('ANTHROPIC_'))
			.sort()
		expect(anthropic).toEqual(expected)
		expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
	})

	test('keeps what the process needs and where its sessions live, drops the subscription login and the app’s secrets', () => {
		expect(env.PATH).toBe('/usr/bin')
		expect(env.HOME).toBe('/data')
		expect(env.CLAUDE_CONFIG_DIR).toBe('/data/.claude')
		for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'DATABASE_URL', 'OPENROUTER_API_KEY', 'LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN']) {
			expect(env[name], name).toBeUndefined()
		}
	})

	test('the gateway credentials are named for the sandbox to hide from a shell', () => {
		expect(engineAuthEnvNames(env)).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])
	})
})

test.describe('readGatewayConfig', () => {
	test('needs both settings, and a blank one counts as missing', () => {
		expect(readGatewayConfig({})).toBeNull()
		expect(readGatewayConfig({ LLM_GATEWAY_URL: 'https://openrouter.ai/api' })).toBeNull()
		expect(readGatewayConfig({ LLM_GATEWAY_TOKEN: 't' })).toBeNull()
		// docker-compose passes `${LLM_GATEWAY_URL:-}` through as an empty string when unset.
		expect(readGatewayConfig({ LLM_GATEWAY_URL: '', LLM_GATEWAY_TOKEN: '' })).toBeNull()
		expect(readGatewayConfig({ LLM_GATEWAY_URL: '  ', LLM_GATEWAY_TOKEN: 't' })).toBeNull()
	})

	test('trims, and drops a trailing slash so paths join cleanly', () => {
		expect(readGatewayConfig({ LLM_GATEWAY_URL: ' https://openrouter.ai/api/ ', LLM_GATEWAY_TOKEN: ' t ' })).toEqual({
			baseUrl: 'https://openrouter.ai/api',
			token: 't',
		})
	})
})

test.describe('gatewayTurnCost', () => {
	const usage = {
		inputTokens: 1_000,
		outputTokens: 500,
		cacheCreationTokens: 200,
		cacheReadTokens: 4_000,
		// The SDK's guess at a Claude rate, which must not be what is recorded.
		costUsd: 9.99,
	}

	test('priced from the catalogue, with cached tokens at the cache prices', () => {
		const cost = gatewayTurnCost(usage, {
			promptPrice: 0.000001,
			completionPrice: 0.000004,
			cacheReadPrice: 0.0000001,
			cacheWritePrice: 0.0000012,
		})
		expect(cost.costBasis).toBe('catalogue')
		// 1000×1e-6 + 200×1.2e-6 + 4000×1e-7 + 500×4e-6
		expect(cost.costUsd).toBeCloseTo(0.001 + 0.00024 + 0.0004 + 0.002, 12)
	})

	test('cached tokens fall back to the prompt price when the catalogue lists no cache price', () => {
		const cost = gatewayTurnCost(usage, { promptPrice: 0.000001, completionPrice: 0.000004 })
		expect(cost.costUsd).toBeCloseTo((1_000 + 200 + 4_000) * 0.000001 + 500 * 0.000004, 12)
	})

	test('a free model costs nothing, and says it was priced', () => {
		expect(gatewayTurnCost(usage, { promptPrice: 0, completionPrice: 0 })).toEqual({ costUsd: 0, costBasis: 'catalogue' })
	})

	test('with no catalogue price, the CLI’s estimate stands in and is marked as one', () => {
		expect(gatewayTurnCost(usage, null)).toEqual({ costUsd: 9.99, costBasis: 'cli-estimate' })
	})

	test('with neither, the turn is recorded at zero and marked unpriced', () => {
		expect(gatewayTurnCost({ ...usage, costUsd: null }, null)).toEqual({ costUsd: 0, costBasis: 'unpriced' })
	})
})

test.describe('ledgerCostOverride — what the chat route hands the usage ledger', () => {
	test('a subscription turn is recorded at zero', () => {
		expect(ledgerCostOverride(null)).toBe(0)
	})

	test('a priced gateway turn is recorded at its price, catalogue or CLI estimate', () => {
		expect(ledgerCostOverride({ costUsd: 0.0123, costBasis: 'catalogue' })).toBe(0.0123)
		expect(ledgerCostOverride({ costUsd: 0, costBasis: 'catalogue' })).toBe(0)
		expect(ledgerCostOverride({ costUsd: 9.99, costBasis: 'cli-estimate' })).toBe(9.99)
	})

	test('an unpriced gateway turn is left to the ledger, which marks it unpriced and warns', () => {
		// An override would write a silent $0; without one the ledger does its own lookup.
		expect(ledgerCostOverride({ costUsd: 0, costBasis: 'unpriced' })).toBeUndefined()
	})
})
