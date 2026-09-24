/**
 * Per-token prices for the usage ledger, from OpenRouter's model catalogue.
 *
 * Two ways this used to record a paid call as costing nothing, without a word:
 *
 * - **The catalogue refresh failed.** The hourly refresh threw away the copy it already had
 *   and answered "no price", so an OpenRouter hiccup zeroed every call logged until the next
 *   successful refresh — although yesterday's prices were sitting in memory.
 * - **The model was not in the catalogue.** Embedding models, for one, are not listed.
 *
 * Budget limits add up the ledger's `cost` column, so a silent zero is spend a limit never
 * sees. Now a failed refresh keeps serving the previous copy (and retries after
 * `REFRESH_RETRY_MS`, not on every call), and a call that genuinely cannot be priced says so:
 * the caller marks the row unpriced and a warning is logged. No price is ever invented.
 *
 * `load` and `now` are parameters so a spec can drive a refresh failure without a network.
 */

import { logger } from '$lib/observability/logger'
import { toOpenRouterModelId } from '$lib/llm/openrouter-model'

export type ModelPrice = {
	promptPrice: number
	completionPrice: number
	/**
	 * Per-token price of a cached prompt token read, and of one written to the cache. Null when
	 * the catalogue lists none; the ledger ignores them, the gateway's per-turn pricing (#9)
	 * falls back to the prompt price.
	 */
	cacheReadPrice?: number | null
	cacheWritePrice?: number | null
}

export type UnpricedReason = 'catalogue_unavailable' | 'model_not_in_catalogue'

export type PriceLookup = ({ status: 'priced' } & ModelPrice) | { status: 'unpriced'; reason: UnpricedReason }

type CatalogueEntry = {
	id: string
	promptPrice: string
	completionPrice: string
	cacheReadPrice?: string | null
	cacheWritePrice?: string | null
}

/** A catalogue price that may be missing or malformed: a number, or null. */
function optionalPrice(value: string | null | undefined): number | null {
	const parsed = value == null ? NaN : parseFloat(value)
	return Number.isFinite(parsed) ? parsed : null
}

export const PRICE_TABLE_TTL_MS = 60 * 60 * 1000
/** After a failed refresh, how long the previous copy is served before trying again. */
export const REFRESH_RETRY_MS = 5 * 60 * 1000
/** With no copy at all, try again sooner — every call until then is unpriced. */
export const FIRST_LOAD_RETRY_MS = 60 * 1000

export type ModelPriceTable = {
	lookup(modelId: string): Promise<PriceLookup>
}

export function createModelPriceTable(
	load: () => Promise<CatalogueEntry[]>,
	options: { ttlMs?: number; retryMs?: number; now?: () => number } = {},
): ModelPriceTable {
	const ttlMs = options.ttlMs ?? PRICE_TABLE_TTL_MS
	const retryMs = options.retryMs ?? REFRESH_RETRY_MS
	const now = options.now ?? Date.now
	let catalogue: CatalogueEntry[] | null = null
	let loadedAt = 0
	let nextRefreshAt = 0

	async function current(): Promise<CatalogueEntry[] | null> {
		const at = now()
		// Also holds off after a failed load, so an outage costs one request per retry window
		// rather than one per ledger write.
		if (at < nextRefreshAt) return catalogue
		try {
			catalogue = await load()
			loadedAt = at
			nextRefreshAt = at + ttlMs
		} catch (err) {
			if (catalogue) {
				logger.warn('[costs] model catalogue refresh failed; pricing from the previous copy', {
					err,
					copyAgeMinutes: Math.round((at - loadedAt) / 60_000),
				})
				nextRefreshAt = at + retryMs
			} else {
				logger.warn('[costs] model catalogue unavailable; calls are recorded unpriced', { err })
				nextRefreshAt = at + Math.min(retryMs, FIRST_LOAD_RETRY_MS)
			}
		}
		return catalogue
	}

	return {
		async lookup(modelId) {
			const entries = await current()
			if (!entries) return { status: 'unpriced', reason: 'catalogue_unavailable' }
			// The catalogue is OpenRouter's, so a stored SDK-style id is looked up the way it was sent.
			const catalogueId = toOpenRouterModelId(modelId)
			const entry = entries.find((m) => m.id === catalogueId)
			if (!entry) return { status: 'unpriced', reason: 'model_not_in_catalogue' }
			return {
				status: 'priced',
				promptPrice: parseFloat(entry.promptPrice),
				completionPrice: parseFloat(entry.completionPrice),
				cacheReadPrice: optionalPrice(entry.cacheReadPrice),
				cacheWritePrice: optionalPrice(entry.cacheWritePrice),
			}
		},
	}
}

/**
 * Warn about an unpriced call — once per model and reason in `windowMs`, not on every call.
 * Embeddings are logged per batch and would otherwise bury the logs panel.
 */
export function createUnpricedWarner(options: { windowMs?: number; now?: () => number } = {}) {
	const windowMs = options.windowMs ?? PRICE_TABLE_TTL_MS
	const now = options.now ?? Date.now
	const lastWarned = new Map<string, number>()
	return (input: { model: string; source: string; reason: UnpricedReason }): boolean => {
		const key = `${input.model}|${input.reason}`
		const at = now()
		const last = lastWarned.get(key)
		if (last !== undefined && at - last < windowMs) return false
		lastWarned.set(key, at)
		logger.warn('[costs] a model call could not be priced; recorded as unpriced with no cost', input)
		return true
	}
}
