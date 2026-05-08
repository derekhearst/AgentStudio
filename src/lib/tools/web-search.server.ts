/**
 * SearXNG-backed web search.
 *
 * Hits the configured SearXNG instance's JSON endpoint and normalizes the
 * response shape. Auth is HTTP-Basic when SEARXNG_PASSWORD is set; otherwise
 * the request is unauthenticated (typical for self-hosted instances behind a
 * private network).
 *
 * Extracted from tools.server.ts so the search backend can evolve without
 * touching the tool dispatch surface.
 */

import { getSearxngPassword, getSearxngUrl, getSearxngUsername } from '$lib/server/config'

export type SearchResult = {
	title: string
	url: string
	snippet: string
	engine?: string
	score?: number
}

function buildAuthHeader(): string | undefined {
	const password = getSearxngPassword()
	if (!password) return undefined
	const token = Buffer.from(`${getSearxngUsername()}:${password}`).toString('base64')
	return `Basic ${token}`
}

export async function webSearch(query: string, limit = 8): Promise<SearchResult[]> {
	const searxngUrl = getSearxngUrl()
	if (!searxngUrl) {
		throw new Error('SEARXNG_URL is not configured')
	}

	const url = new URL('/search', searxngUrl)
	url.searchParams.set('q', query)
	url.searchParams.set('format', 'json')

	const authHeader = buildAuthHeader()
	const response = await fetch(url, {
		headers: authHeader ? { Authorization: authHeader } : undefined,
	})

	if (!response.ok) {
		throw new Error(`SearXNG request failed with status ${response.status}`)
	}

	const payload = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string; engine?: string; score?: number }>
	}

	const normalized = (payload.results ?? [])
		.filter((entry) => Boolean(entry.url))
		.map((entry) => ({
			title: entry.title || 'Untitled',
			url: entry.url || '',
			snippet: entry.content || '',
			engine: entry.engine,
			score: entry.score,
		}))

	return normalized.slice(0, limit)
}
