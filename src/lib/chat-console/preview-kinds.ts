/**
 * #29 — shared (client + server) classification of a previewable file.
 *
 * Kept free of node imports so the rail can reason about a path before the
 * server answers, and so the server and the renderer agree on one table.
 */

export type PreviewKind = 'markdown' | 'code' | 'text' | 'image' | 'pdf' | 'binary' | 'directory'

export type PreviewFile = {
	kind: Exclude<PreviewKind, 'directory'>
	/** Path as resolved, relative to the conversation workspace when possible. */
	path: string
	name: string
	size: number
	modifiedAt: string | null
	/** hljs language id for `kind: 'code'`; null otherwise. */
	language: string | null
	/** Text payload for markdown/code/text. Null for image/pdf/binary. */
	content: string | null
	/** True when the file was larger than the text cap and `content` is a prefix. */
	truncated: boolean
	/** Raw-bytes URL for image/pdf. Null for everything else. */
	rawUrl: string | null
	/** Set for `kind: 'binary'` — why we refused to render it. */
	note: string | null
}

export type PreviewDirectory = {
	kind: 'directory'
	path: string
	name: string
	entries: Array<{ name: string; path: string; isDirectory: boolean; size: number }>
	truncated: boolean
}

export type PreviewPayload = PreviewFile | PreviewDirectory

/** Extensions we will hand to the browser as an image. SVG is deliberately absent. */
export const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
}

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx'])

/**
 * Extension → highlight.js language id. Anything not listed renders as plain
 * text, which is the safe default (hljs falls back to `plaintext` anyway).
 */
export const CODE_LANGUAGE: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	jsonc: 'json',
	svelte: 'xml',
	html: 'xml',
	htm: 'xml',
	xml: 'xml',
	svg: 'xml',
	vue: 'xml',
	css: 'css',
	scss: 'scss',
	less: 'less',
	py: 'python',
	rb: 'ruby',
	go: 'go',
	rs: 'rust',
	java: 'java',
	kt: 'kotlin',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	cc: 'cpp',
	hpp: 'cpp',
	cs: 'csharp',
	php: 'php',
	sh: 'bash',
	bash: 'bash',
	zsh: 'bash',
	ps1: 'powershell',
	sql: 'sql',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'ini',
	ini: 'ini',
	cfg: 'ini',
	env: 'ini',
	dockerfile: 'dockerfile',
	diff: 'diff',
	patch: 'diff',
}

const PLAIN_TEXT_EXT = new Set([
	'txt',
	'log',
	'csv',
	'tsv',
	'gitignore',
	'gitattributes',
	'editorconfig',
	'lock',
	'',
])

export function fileExtension(path: string): string {
	const name = baseName(path).toLowerCase()
	if (name === 'dockerfile') return 'dockerfile'
	const dot = name.lastIndexOf('.')
	if (dot <= 0) return ''
	return name.slice(dot + 1)
}

export function baseName(path: string): string {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
	const slash = normalized.lastIndexOf('/')
	return slash === -1 ? normalized : normalized.slice(slash + 1)
}

export function dirName(path: string): string {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
	const slash = normalized.lastIndexOf('/')
	return slash <= 0 ? '' : normalized.slice(0, slash)
}

export type ExtensionClass =
	| { kind: 'markdown' }
	| { kind: 'image'; mime: string }
	| { kind: 'pdf' }
	| { kind: 'code'; language: string }
	| { kind: 'text' }

/** Classify purely by extension. Content sniffing for binaries happens server-side. */
export function classifyExtension(path: string): ExtensionClass {
	const ext = fileExtension(path)
	if (MARKDOWN_EXT.has(ext)) return { kind: 'markdown' }
	if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] }
	if (ext === 'pdf') return { kind: 'pdf' }
	const language = CODE_LANGUAGE[ext]
	if (language) return { kind: 'code', language }
	if (PLAIN_TEXT_EXT.has(ext)) return { kind: 'text' }
	return { kind: 'text' }
}

/**
 * Only http(s) is previewable. `javascript:`, `data:` and `file:` are the whole
 * reason this check exists — an agent-supplied string must never become an
 * iframe src on our origin without passing through here.
 */
export function normalizePreviewUrl(raw: string): string | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	// Bare host[:port] forms ("localhost:5173", "example.com/docs") are what a dev
	// server prints, so they get an http:// prefix. The host check matters:
	// without it `localhost:5173` parses as the scheme "localhost", and
	// `javascript:1` would parse as the host "javascript" on port 1.
	const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
	const isHostPort =
		/^(?:localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{1,5})?(?:[/?#]|$)/i.test(
			trimmed,
		)
	let candidate = trimmed
	if (!hasScheme || isHostPort) candidate = `http://${trimmed}`
	let url: URL
	try {
		url = new URL(candidate)
	} catch {
		return null
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
	return url.toString()
}

/**
 * Does this string address a file rather than a web page?
 *
 * Deliberately deterministic rather than clever. A bare `notes.md` is
 * indistinguishable from a domain (`.md` is a real TLD), and guessing wrong
 * means silently navigating somewhere the user did not ask for. So only an
 * explicit scheme or a loopback host counts as a URL; everything else is a
 * path, and the rail says to prefix `https://` if the web was meant.
 */
export function looksLikePath(raw: string): boolean {
	const trimmed = raw.trim()
	if (!trimmed) return false
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false
	if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:[/?#]|$)/i.test(trimmed)) return false
	return true
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Rail tab identifiers. Lives here rather than in `preview.remote.ts` because a
 * `*.remote.ts` module may only export remote functions.
 *
 * #14 removed Research and Activity. A row stored with either still reads back fine:
 * `getRailPreviewState` maps any tab it does not know to Preview.
 */
export const RAIL_TABS = ['Preview', 'Files'] as const
export type RailTab = (typeof RAIL_TABS)[number]

export type RailPreviewState = {
	tab: RailTab
	kind: 'none' | 'file' | 'url'
	target: string | null
}
