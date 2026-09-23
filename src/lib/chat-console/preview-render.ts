import { Marked, type Token, type Tokens } from 'marked'
import hljs from 'highlight.js/lib/core'
import { escapeHtml, sanitizedText, sanitizerHolds } from '$lib/util/safe-markdown'
import { dirName, normalizePreviewUrl } from './preview-kinds'

/**
 * #29 — rendering for the rail preview.
 *
 * Two rules drive everything here:
 *
 * 1. **A previewed file is untrusted.** It was written by the agent, or pulled
 *    off a web page the agent read. Rendering its markdown with stock `marked`
 *    would let it inject `<script>` / `<img onerror>` into our origin, so the
 *    renderer below drops raw HTML and refuses any link or image URL that is
 *    not http/https (which kills `javascript:` and `data:`).
 * 2. **Languages load on demand.** highlight.js has ~200 grammars; the rail
 *    ships none of them until a file that needs one is opened.
 */

/* ── highlight.js, lazily ──────────────────────────────────────── */

const LANGUAGE_MODULES: Record<string, () => Promise<{ default: unknown }>> = {
	bash: () => import('highlight.js/lib/languages/bash'),
	c: () => import('highlight.js/lib/languages/c'),
	cpp: () => import('highlight.js/lib/languages/cpp'),
	csharp: () => import('highlight.js/lib/languages/csharp'),
	css: () => import('highlight.js/lib/languages/css'),
	diff: () => import('highlight.js/lib/languages/diff'),
	dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
	go: () => import('highlight.js/lib/languages/go'),
	ini: () => import('highlight.js/lib/languages/ini'),
	java: () => import('highlight.js/lib/languages/java'),
	javascript: () => import('highlight.js/lib/languages/javascript'),
	json: () => import('highlight.js/lib/languages/json'),
	kotlin: () => import('highlight.js/lib/languages/kotlin'),
	less: () => import('highlight.js/lib/languages/less'),
	markdown: () => import('highlight.js/lib/languages/markdown'),
	php: () => import('highlight.js/lib/languages/php'),
	plaintext: () => import('highlight.js/lib/languages/plaintext'),
	powershell: () => import('highlight.js/lib/languages/powershell'),
	python: () => import('highlight.js/lib/languages/python'),
	ruby: () => import('highlight.js/lib/languages/ruby'),
	rust: () => import('highlight.js/lib/languages/rust'),
	scss: () => import('highlight.js/lib/languages/scss'),
	sql: () => import('highlight.js/lib/languages/sql'),
	typescript: () => import('highlight.js/lib/languages/typescript'),
	xml: () => import('highlight.js/lib/languages/xml'),
	yaml: () => import('highlight.js/lib/languages/yaml'),
}

const ALIASES: Record<string, string> = {
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	node: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	console: 'bash',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	kt: 'kotlin',
	cs: 'csharp',
	h: 'c',
	cc: 'cpp',
	hpp: 'cpp',
	'c++': 'cpp',
	yml: 'yaml',
	toml: 'ini',
	cfg: 'ini',
	env: 'ini',
	html: 'xml',
	htm: 'xml',
	svg: 'xml',
	svelte: 'xml',
	vue: 'xml',
	md: 'markdown',
	patch: 'diff',
	ps1: 'powershell',
	text: 'plaintext',
	txt: 'plaintext',
}

function canonicalLanguage(raw: string | null | undefined): string | null {
	if (!raw) return null
	const key = raw.trim().toLowerCase()
	if (!key) return null
	const canonical = ALIASES[key] ?? key
	return LANGUAGE_MODULES[canonical] ? canonical : null
}

const loaded = new Set<string>()

async function ensureLanguage(raw: string | null | undefined): Promise<string | null> {
	const canonical = canonicalLanguage(raw)
	if (!canonical) return null
	if (loaded.has(canonical) || hljs.getLanguage(canonical)) {
		loaded.add(canonical)
		return canonical
	}
	try {
		const mod = await LANGUAGE_MODULES[canonical]()
		hljs.registerLanguage(canonical, mod.default as Parameters<typeof hljs.registerLanguage>[1])
		loaded.add(canonical)
		return canonical
	} catch {
		return null
	}
}

function highlightSync(code: string, language: string | null): string {
	if (language && hljs.getLanguage(language)) {
		try {
			return hljs.highlight(code, { language, ignoreIllegals: true }).value
		} catch {
			/* fall through to plain text */
		}
	}
	return escapeHtml(code)
}

/** Highlighted `<code>` inner HTML for a whole file. */
export async function renderPreviewCode(source: string, language: string | null): Promise<string> {
	const resolved = await ensureLanguage(language)
	return highlightSync(source, resolved)
}

/** Line numbers as a separate gutter column so copying the code stays clean. */
export function lineNumbers(source: string): number[] {
	const count = source.length === 0 ? 1 : source.split('\n').length
	return Array.from({ length: count }, (_, i) => i + 1)
}

/* ── markdown ──────────────────────────────────────────────────── */

export type MarkdownContext = {
	conversationId: string | null
	/** Path of the markdown file, used to resolve relative image sources. */
	filePath: string | null
}

let activeContext: MarkdownContext = { conversationId: null, filePath: null }

function rawUrlFor(path: string): string | null {
	if (!activeContext.conversationId) return null
	const params = new URLSearchParams({ conversationId: activeContext.conversationId, path })
	return `/api/preview/raw?${params.toString()}`
}

function resolveImageSrc(href: string): string | null {
	const external = normalizePreviewUrl(href)
	if (external && /^https?:/i.test(href.trim())) return external
	// Relative reference inside the workspace — point it at the raw endpoint,
	// which serves images only and re-validates containment.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href.trim())) return null
	const dir = activeContext.filePath ? dirName(activeContext.filePath) : ''
	const joined = dir ? `${dir}/${href}` : href
	return rawUrlFor(joined)
}

/**
 * marked only honours *own enumerable* properties of the object handed to
 * `use({ renderer })`. A subclass of `Renderer` puts its overrides on the
 * prototype, so they are silently ignored — this has to be an object literal,
 * and the sanitization is load-bearing, so it is covered by the check below.
 */
type RendererThis = { parser: { parseInline(tokens: Token[]): string } }

const previewMarked = new Marked({ gfm: true, breaks: false })

previewMarked.use({
	renderer: {
		/**
		 * Raw HTML in a previewed file is shown, not executed. Dropping it
		 * silently would misrepresent the file; escaping it shows what is on disk.
		 */
		html({ text }: Tokens.HTML | Tokens.Tag): string {
			return escapeHtml(text)
		},

		/**
		 * After an inline `<kbd>`/`<code>`/`<pre>`/`<script>` tag, marked emits the
		 * following text raw, so escaping the tag above is not enough on its own.
		 */
		text: sanitizedText,

		link(this: RendererThis, { href, title, tokens }: Tokens.Link): string {
			const inner = this.parser.parseInline(tokens)
			const safe = normalizePreviewUrl(href)
			if (!safe) return inner
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
			return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer nofollow"${titleAttr}>${inner}</a>`
		},

		image({ href, title, text }: Tokens.Image): string {
			const src = resolveImageSrc(href)
			if (!src) return escapeHtml(text || href)
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
			return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text ?? '')}"${titleAttr} loading="lazy" />`
		},

		code({ text, lang }: Tokens.Code): string {
			const language = canonicalLanguage(lang ?? null)
			const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ' class="hljs"'
			return `<pre><code${cls}>${highlightSync(text, language)}</code></pre>\n`
		},
	},
})

/**
 * Self-check: prove the overrides above actually took effect before we ever
 * feed a real file through them. A marked upgrade that changes how `use()`
 * collects renderer methods would otherwise turn this module back into an
 * unsanitized HTML pipe without a single test failing. If the probe leaks, we
 * stop rendering markdown at all and show the source instead.
 */
const SANITIZER_INTACT = sanitizerHolds((source) => previewMarked.parse(source) as string)

const FENCE_LANG = /^[ \t]*(?:```|~~~)[ \t]*([A-Za-z0-9_+#.-]+)/gm

/**
 * Render markdown for the rail. Async because fenced-code grammars are fetched
 * before parsing, so the single synchronous `marked` pass can highlight them.
 */
export async function renderPreviewMarkdown(source: string, context: MarkdownContext): Promise<string> {
	if (!SANITIZER_INTACT) return `<pre><code>${escapeHtml(source)}</code></pre>`

	const languages = new Set<string>()
	for (const match of source.matchAll(FENCE_LANG)) {
		if (match[1]) languages.add(match[1])
	}
	await Promise.all([...languages].map((lang) => ensureLanguage(lang)))

	activeContext = context
	try {
		return previewMarked.parse(source) as string
	} finally {
		activeContext = { conversationId: null, filePath: null }
	}
}
