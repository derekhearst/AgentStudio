import { env } from '$env/dynamic/private'

export type SearchResult = {
	title: string
	url: string
	snippet: string
	engine?: string
	score?: number
}

function buildAuthHeader() {
	if (!env.SEARXNG_PASSWORD) return undefined
	const username = env.SEARXNG_USERNAME || 'derek'
	const token = Buffer.from(`${username}:${env.SEARXNG_PASSWORD}`).toString('base64')
	return `Basic ${token}`
}

export async function webSearch(query: string, limit = 8): Promise<SearchResult[]> {
	if (env.E2E_MOCK_EXTERNALS === '1') {
		return [
			{
				title: `Mock result for ${query}`,
				url: 'https://example.com/mock-result',
				snippet: 'Deterministic mock search result for E2E execution.',
				engine: 'mock',
				score: 1,
			},
		].slice(0, limit)
	}

	if (!env.SEARXNG_URL) {
		throw new Error('SEARXNG_URL is not configured')
	}

	const url = new URL('/search', env.SEARXNG_URL)
	url.searchParams.set('q', query)
	url.searchParams.set('format', 'json')

	const authHeader = buildAuthHeader()
	const response = await fetch(url, {
		headers: authHeader
			? {
					Authorization: authHeader,
				}
			: undefined,
	})

	if (!response.ok) {
		throw new Error(`SearXNG request failed with status ${response.status}`)
	}

	const payload = (await response.json()) as {
		results?: Array<{
			title?: string
			url?: string
			content?: string
			engine?: string
			score?: number
		}>
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
