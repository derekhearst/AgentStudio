export type ToolCardStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'denied'

type ToolCopy = {
	inProgress: string
	completed: string
	denied: string
}

type WebSearchPreview = {
	count: number
	hosts: string[]
}

const TOOL_COPY: Record<string, ToolCopy> = {
	web_search: {
		inProgress: 'Searching the web',
		completed: 'Searched the web',
		denied: 'Web search was denied',
	},
	memory_search: {
		inProgress: 'Searching memory',
		completed: 'Searched memory',
		denied: 'Memory search was denied',
	},
	search_files: {
		inProgress: 'Searching files',
		completed: 'Searched files',
		denied: 'File search was denied',
	},
	file_read: {
		inProgress: 'Reading a file',
		completed: 'Read a file',
		denied: 'File read was denied',
	},
	file_write: {
		inProgress: 'Writing a file',
		completed: 'Wrote a file',
		denied: 'File write was denied',
	},
	file_patch: {
		inProgress: 'Applying file patch',
		completed: 'Applied file patch',
		denied: 'File patch was denied',
	},
	file_replace: {
		inProgress: 'Replacing text in files',
		completed: 'Replaced text in files',
		denied: 'File replace was denied',
	},
	shell: {
		inProgress: 'Running shell command',
		completed: 'Ran shell command',
		denied: 'Shell command was denied',
	},
	browser_navigate: {
		inProgress: 'Opening a web page',
		completed: 'Opened a web page',
		denied: 'Navigation was denied',
	},
	browser_screenshot: {
		inProgress: 'Taking a screenshot',
		completed: 'Captured a screenshot',
		denied: 'Screenshot capture was denied',
	},
}

const QUERY_FIELDS = ['query', 'q', 'prompt', 'keywords', 'search']
const PATH_FIELDS = ['path', 'filePath', 'dirPath', 'url']

function toTitleCase(value: string) {
	return value
		.split(' ')
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(' ')
}

function fallbackToolLabel(name: string) {
	return toTitleCase(name.replace(/[_-]+/g, ' '))
}

function extractShortValue(args: unknown, candidates: string[]): string | null {
	if (!args || typeof args !== 'object') return null
	const obj = args as Record<string, unknown>
	for (const key of candidates) {
		const value = obj[key]
		if (typeof value !== 'string') continue
		const trimmed = value.trim()
		if (!trimmed) continue
		if (trimmed.length > 90) return `${trimmed.slice(0, 87)}...`
		return trimmed
	}
	return null
}

export function parseJsonValue(raw: string): unknown {
	if (!raw?.trim()) return null
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

export function getFriendlyToolLabel(name: string, args: unknown, status: ToolCardStatus = 'completed') {
	const copy = TOOL_COPY[name]
	const query = extractShortValue(args, QUERY_FIELDS)
	const path = extractShortValue(args, PATH_FIELDS)

	if (status === 'denied') {
		return copy?.denied ?? `${fallbackToolLabel(name)} was denied`
	}

	const base =
		status === 'completed'
			? (copy?.completed ?? `Completed ${fallbackToolLabel(name).toLowerCase()}`)
			: (copy?.inProgress ?? `${fallbackToolLabel(name)} in progress`)

	if (query && ['web_search', 'memory_search', 'search_files'].includes(name)) {
		return `${base} for "${query}"`
	}

	if (path && ['file_read', 'file_write', 'file_patch', 'file_replace', 'browser_navigate'].includes(name)) {
		return `${base}: ${path}`
	}

	return base
}

function parseWebResult(rawResult: unknown): Array<{ url?: string }> {
	if (Array.isArray(rawResult)) {
		return rawResult.filter((entry) => Boolean(entry) && typeof entry === 'object') as Array<{ url?: string }>
	}

	if (rawResult && typeof rawResult === 'object') {
		const maybeResults = (rawResult as { results?: unknown }).results
		if (Array.isArray(maybeResults)) {
			return maybeResults.filter((entry) => Boolean(entry) && typeof entry === 'object') as Array<{ url?: string }>
		}
	}

	return []
}

export function getWebSearchPreview(toolName: string, rawResult: unknown): WebSearchPreview | null {
	if (toolName !== 'web_search') return null

	const results = parseWebResult(rawResult)
	if (results.length === 0) return { count: 0, hosts: [] }

	const hosts = new Set<string>()
	for (const entry of results) {
		if (!entry.url || typeof entry.url !== 'string') continue
		try {
			const hostname = new URL(entry.url).hostname
			if (hostname) hosts.add(hostname)
		} catch {
			// Ignore malformed URLs in tool output.
		}
		if (hosts.size >= 4) break
	}

	return {
		count: results.length,
		hosts: [...hosts],
	}
}

export function faviconUrl(hostname: string) {
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`
}
