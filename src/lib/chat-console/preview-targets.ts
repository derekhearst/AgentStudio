import { looksLikePath, normalizePreviewUrl } from './preview-kinds'

/**
 * #29 — what, if anything, a tool call offers to preview.
 *
 * Everything this reads (arguments and results alike) is model- or page-derived
 * text. It is used only to *offer* a target: file chips open a path that the
 * preview endpoint re-validates against the sandbox, and URL chips go through
 * `proposeUrlPreview`, which shows the URL and waits for a click instead of
 * framing it.
 */

export type PreviewTarget =
	| { kind: 'file'; path: string; label: string }
	| { kind: 'url'; url: string; label: string; source: string }

const PATH_KEYS = ['path', 'filePath', 'file_path', 'dirPath', 'dir_path', 'target', 'destination', 'output']
const URL_KEYS = ['url', 'href', 'link']

/** Local dev servers the agent may have started, pulled out of shell/tool output. */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'`<>)\]]*)?/gi

const MAX_TARGETS = 4

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

function shorten(value: string, max = 42): string {
	if (value.length <= max) return value
	return `…${value.slice(value.length - (max - 1))}`
}

export function toolPreviewTargets(toolName: string, args: unknown, result: unknown): PreviewTarget[] {
	const targets: PreviewTarget[] = []
	const seen = new Set<string>()

	const push = (target: PreviewTarget) => {
		const key = target.kind === 'file' ? `f:${target.path}` : `u:${target.url}`
		if (seen.has(key) || targets.length >= MAX_TARGETS) return
		seen.add(key)
		targets.push(target)
	}

	const argRecord = asRecord(args)
	if (argRecord) {
		for (const key of PATH_KEYS) {
			const value = argRecord[key]
			if (typeof value !== 'string') continue
			const trimmed = value.trim()
			if (!trimmed || trimmed.length > 512) continue
			if (!looksLikePath(trimmed)) continue
			push({ kind: 'file', path: trimmed, label: shorten(trimmed) })
		}
		for (const key of URL_KEYS) {
			const value = argRecord[key]
			if (typeof value !== 'string') continue
			// Require an explicit scheme. A relative string in a `url` argument would
			// otherwise be promoted to `http://<whatever>` and offered as a website.
			if (!/^https?:\/\//i.test(value.trim())) continue
			const url = normalizePreviewUrl(value)
			if (!url) continue
			push({ kind: 'url', url, label: shorten(url, 48), source: toolName })
		}
	}

	const resultText =
		typeof result === 'string' ? result : result && typeof result === 'object' ? safeStringify(result) : ''
	if (resultText) {
		for (const match of resultText.slice(0, 20_000).matchAll(LOCAL_URL)) {
			const url = normalizePreviewUrl(match[0])
			if (!url) continue
			push({ kind: 'url', url, label: shorten(url, 48), source: `${toolName} output` })
		}
	}

	return targets
}

function safeStringify(value: object): string {
	try {
		return JSON.stringify(value)
	} catch {
		return ''
	}
}
