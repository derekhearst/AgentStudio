/**
 * OpenRouter credits balance.
 *
 * Read-only call to https://openrouter.ai/api/v1/credits returning total credits, total usage,
 * and remaining balance. In-memory cached for 60s — the figure changes monotonically and the
 * UI only needs ballpark accuracy.
 */

import { logger } from '$lib/observability/logger'

const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits'
const CACHE_TTL_MS = 60_000

export type CreditsBalance = {
	totalCredits: number
	totalUsage: number
	remaining: number
	fetchedAt: string
}

let cached: { balance: CreditsBalance; expiresAt: number } | null = null

export async function getCreditsBalance(force = false): Promise<CreditsBalance | null> {
	if (!force && cached && cached.expiresAt > Date.now()) {
		return cached.balance
	}
	if (!process.env.OPENROUTER_API_KEY) {
		return null
	}

	try {
		const response = await fetch(OPENROUTER_CREDITS_URL, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
			},
		})
		if (!response.ok) {
			logger.warn('[credits] non-OK response', { status: response.status })
			return null
		}
		const json = (await response.json()) as {
			data?: { total_credits?: number; total_usage?: number }
		}
		const totalCredits = Number(json.data?.total_credits ?? 0)
		const totalUsage = Number(json.data?.total_usage ?? 0)
		const balance: CreditsBalance = {
			totalCredits,
			totalUsage,
			remaining: Math.max(0, totalCredits - totalUsage),
			fetchedAt: new Date().toISOString(),
		}
		cached = { balance, expiresAt: Date.now() + CACHE_TTL_MS }
		return balance
	} catch (err) {
		logger.warn('[credits] fetch failed', { err })
		return null
	}
}
