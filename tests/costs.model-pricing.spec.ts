import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * The usage ledger never records a paid call as free without saying so.
 *
 * It used to, two ways. A failed hourly catalogue refresh threw away the prices already in
 * memory, so every call logged during an OpenRouter hiccup cost $0; and a model missing
 * from the catalogue (bare SDK ids, embedding models) cost $0 too. Budget limits add these
 * rows up, so a silent zero is spend a limit never sees.
 */

const CATALOGUE = [
	{ id: 'anthropic/claude-sonnet-5', promptPrice: '0.000003', completionPrice: '0.000015' },
	{ id: 'openai/gpt-4o-mini', promptPrice: '0.00000015', completionPrice: '0.0000006' },
]

test.describe('costs/model-pricing — the price table', () => {
	test('prices an SDK-style id against the OpenRouter catalogue', async () => {
		const { createModelPriceTable } = await import('../src/lib/costs/model-pricing')
		const table = createModelPriceTable(async () => CATALOGUE)
		const price = await table.lookup('claude-sonnet-5')
		expect(price).toEqual({ status: 'priced', promptPrice: 0.000003, completionPrice: 0.000015 })
	})

	test('a failed refresh keeps pricing from the previous copy, and waits before retrying', async () => {
		const { createModelPriceTable } = await import('../src/lib/costs/model-pricing')
		let clock = 0
		let loads = 0
		let failing = false
		const table = createModelPriceTable(
			async () => {
				loads += 1
				if (failing) throw new Error('openrouter /models timed out')
				return CATALOGUE
			},
			{ ttlMs: 1_000, retryMs: 500, now: () => clock },
		)

		expect((await table.lookup('openai/gpt-4o-mini')).status).toBe('priced')
		expect(loads).toBe(1)

		// The copy expires and the refresh fails: yesterday's price is still the right answer.
		failing = true
		clock = 1_500
		expect(await table.lookup('openai/gpt-4o-mini')).toMatchObject({ status: 'priced', promptPrice: 0.00000015 })
		expect(loads).toBe(2)

		// Inside the retry window nothing is fetched — an outage is not one request per call.
		clock = 1_800
		expect((await table.lookup('openai/gpt-4o-mini')).status).toBe('priced')
		expect(loads).toBe(2)

		clock = 2_100
		failing = false
		expect((await table.lookup('openai/gpt-4o-mini')).status).toBe('priced')
		expect(loads).toBe(3)
	})

	test('with no copy at all the call is unpriced, with the reason', async () => {
		const { createModelPriceTable } = await import('../src/lib/costs/model-pricing')
		const table = createModelPriceTable(async () => {
			throw new Error('OPENROUTER_API_KEY is not configured')
		})
		expect(await table.lookup('claude-sonnet-5')).toEqual({ status: 'unpriced', reason: 'catalogue_unavailable' })
	})

	test('a model the catalogue does not list is unpriced, not free', async () => {
		const { createModelPriceTable } = await import('../src/lib/costs/model-pricing')
		const table = createModelPriceTable(async () => CATALOGUE)
		expect(await table.lookup('openai/text-embedding-3-small')).toEqual({
			status: 'unpriced',
			reason: 'model_not_in_catalogue',
		})
	})

	test('the unpriced warning fires once per model and reason in its window', async () => {
		const { createUnpricedWarner } = await import('../src/lib/costs/model-pricing')
		let clock = 0
		const warn = createUnpricedWarner({ windowMs: 1_000, now: () => clock })
		const call = { model: 'openai/text-embedding-3-small', source: 'memory_embed', reason: 'model_not_in_catalogue' as const }
		expect(warn(call)).toBe(true)
		expect(warn(call)).toBe(false)
		expect(warn({ ...call, model: 'other/model' })).toBe(true)
		clock = 1_001
		expect(warn(call)).toBe(true)
	})
})

test.describe('costs/model-pricing — the ledger row', () => {
	test('an unpriced call is written with metadata.unpriced, not as a silent zero', async () => {
		const prefix = uniquePrefix('unpriced-row')
		const sql = getSql()
		try {
			const { logLlmUsage } = await import('../src/lib/costs/usage')
			const cost = await logLlmUsage({
				source: 'evaluator',
				model: 'e2e-vendor/not-a-real-model',
				tokensIn: 1_000,
				tokensOut: 500,
				metadata: { spec: prefix },
			})
			expect(parseFloat(cost)).toBe(0)
			const [row] = await sql<{ cost: string; metadata: { spec?: string; unpriced?: string } }[]>`
				select cost::text as cost, metadata from llm_usage where metadata->>'spec' = ${prefix}
			`
			expect(parseFloat(row.cost)).toBe(0)
			// Which reason depends on whether this machine can reach the catalogue at all.
			expect(['model_not_in_catalogue', 'catalogue_unavailable']).toContain(row.metadata.unpriced)
		} finally {
			await sql`delete from llm_usage where metadata->>'spec' = ${prefix}`
		}
	})

	test('a caller-supplied cost is recorded as it is, and not flagged', async () => {
		const prefix = uniquePrefix('priced-override')
		const sql = getSql()
		try {
			const { logLlmUsage } = await import('../src/lib/costs/usage')
			await logLlmUsage({
				source: 'tts',
				model: 'e2e-vendor/not-a-real-model',
				tokensIn: 10,
				tokensOut: 0,
				costOverride: 0.0123,
				metadata: { spec: prefix },
			})
			const [row] = await sql<{ cost: string; metadata: { unpriced?: string } }[]>`
				select cost::text as cost, metadata from llm_usage where metadata->>'spec' = ${prefix}
			`
			expect(parseFloat(row.cost)).toBeCloseTo(0.0123, 6)
			expect(row.metadata.unpriced).toBeUndefined()
		} finally {
			await sql`delete from llm_usage where metadata->>'spec' = ${prefix}`
		}
	})
})
