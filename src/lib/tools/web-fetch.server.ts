/**
 * Web fetch + PDF read tools.
 *
 * Both tools share the same SSRF defense (`validateFetchUrl` from
 * `$lib/research/web-fetch`) and the same paragraph-aware truncation, so they
 * live together. PDF read either downloads from a URL or reads from a sandbox
 * path; web fetch always navigates with the shared Playwright browser singleton.
 *
 * Extracted from tools.server.ts so adding new fetch-style tools doesn't bloat
 * the dispatch surface further.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile as fsWriteFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
	cleanupExtractedText,
	truncateAtParagraph,
	validateFetchUrl,
} from '$lib/research/web-fetch'
import { safePathWithin } from '$lib/workspace/workspace.server'
import {
	ensureWorkspaceDir,
	getPage,
	getWorkspace,
	toolUserContext,
} from './sandbox.server'

/**
 * Wave 4 #18 phase 1 — `web_fetch` tool implementation.
 *
 * Reuses the existing Playwright browser singleton (same one `browser_screenshot` uses) so we
 * don't fight over chromium processes. Returns the page's text content trimmed to maxChars.
 *
 * SAFETY: URL goes through `validateFetchUrl` BEFORE the network call so private/loopback
 * addresses are blocked at the boundary (SSRF defense). Also wraps the navigate in a 30s
 * timeout — sites that hang past that fail rather than tying up the worker indefinitely.
 *
 * Boilerplate strip + paragraph-boundary truncation are pure helpers in `$lib/research/web-fetch`
 * so the URL safety contract is testable without booting Playwright.
 */
export async function webFetch(rawUrl: string, maxChars = 50_000) {
	const validation = validateFetchUrl(rawUrl)
	if (!validation.ok) {
		throw new Error(validation.error)
	}
	const targetUrl = validation.url.toString()
	const p = await getPage()
	await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
	// Best-effort: also wait for network to settle briefly so SPA pages have time to render.
	await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)

	const title = await p.title().catch(() => '')
	const finalUrl = p.url()
	const rawText = (await p.textContent('body').catch(() => '')) ?? ''
	const cleaned = cleanupExtractedText(rawText)
	const text = truncateAtParagraph(cleaned, maxChars)

	return {
		title,
		url: finalUrl,
		text,
		fetchedAt: new Date().toISOString(),
		fullCharCount: cleaned.length,
		truncated: cleaned.length > maxChars,
	}
}

/**
 * Wave 4 #18 phase 5 — `pdf_read` tool implementation.
 *
 * Shells out to `pdftotext` (poppler-utils, available in most Linux/macOS dev environments
 * + the production Docker image). Accepts either:
 *   - HTTP(S) URL — downloads to a temp file via fetch(), then runs pdftotext
 *   - Absolute path inside the user's sandbox workspace — used directly
 *
 * URL validation reuses the SSRF defense from web_fetch (private/loopback rejection). Path
 * validation uses safePathWithin so an agent can't traverse out of its sandbox via `../`.
 *
 * Returns the extracted text trimmed to maxChars at the nearest paragraph boundary. When
 * pdftotext is missing, returns a structured error with install instructions instead of
 * crashing the run.
 */
export async function pdfRead(
	rawSource: string,
	maxChars = 100_000,
): Promise<{
	source: string
	text: string
	charCount: number
	truncated: boolean
	pageHint: number | null
}> {
	const trimmed = rawSource.trim()
	let pdfPath: string
	let cleanupTempDir: string | null = null
	let resolvedSource = trimmed

	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		const validation = validateFetchUrl(trimmed)
		if (!validation.ok) throw new Error(validation.error)
		// Download to a tmp dir.
		const tempDir = await mkdtemp(join(tmpdir(), 'pdf-read-'))
		cleanupTempDir = tempDir
		const response = await fetch(validation.url.toString(), {
			signal: AbortSignal.timeout(45_000),
		})
		if (!response.ok) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
			throw new Error(`failed to download PDF: HTTP ${response.status}`)
		}
		const buf = Buffer.from(await response.arrayBuffer())
		pdfPath = join(tempDir, 'source.pdf')
		await fsWriteFile(pdfPath, buf)
		resolvedSource = validation.url.toString()
	} else {
		// Treat as a path inside the user's sandbox workspace.
		const ctxSnapshot = toolUserContext.getStore()
		if (!ctxSnapshot?.userId) throw new Error('Missing user context for pdf_read')
		await ensureWorkspaceDir()
		const workspaceRoot = getWorkspace()
		pdfPath = await safePathWithin(workspaceRoot, trimmed)
		const fileStat = await stat(pdfPath).catch(() => null)
		if (!fileStat || !fileStat.isFile()) {
			throw new Error(`PDF not found at sandbox path: ${trimmed}`)
		}
	}

	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			const proc = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			const out: Buffer[] = []
			const err: Buffer[] = []
			proc.stdout.on('data', (chunk) => out.push(chunk as Buffer))
			proc.stderr.on('data', (chunk) => err.push(chunk as Buffer))
			proc.on('error', (e) => {
				if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(
						new Error(
							'pdftotext binary not found — install poppler-utils (apt-get install poppler-utils on Debian/Ubuntu, brew install poppler on macOS) to enable pdf_read.',
						),
					)
				} else {
					reject(e)
				}
			})
			proc.on('close', (code) => {
				if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
				else
					reject(
						new Error(
							`pdftotext exited with code ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`,
						),
					)
			})
		})

		const cleaned = cleanupExtractedText(stdout)
		const text = truncateAtParagraph(cleaned, maxChars)
		// pdftotext doesn't expose a page count from the -layout pipe, but we can hint by
		// counting form-feed characters which it inserts between pages.
		const pageHint = (stdout.match(/\f/g) ?? []).length || null
		return {
			source: resolvedSource,
			text,
			charCount: cleaned.length,
			truncated: cleaned.length > maxChars,
			pageHint,
		}
	} finally {
		if (cleanupTempDir) {
			await rm(cleanupTempDir, { recursive: true, force: true }).catch(() => undefined)
		}
	}
}
