/**
 * Web fetch + PDF read tools.
 *
 * Both reach the network through the egress guard (`egress.server.ts`): public internet
 * only, checked on every resolved address and every redirect hop. They also share the same
 * paragraph-aware truncation, so they live together. PDF read either downloads from a URL or
 * reads from a sandbox path; web fetch loads the page in a throwaway browser context.
 *
 * Extracted from tools.server.ts so adding new fetch-style tools doesn't bloat
 * the dispatch surface further.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { LookupFunction } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from 'playwright'
import { cleanupExtractedText, truncateAtParagraph } from '$lib/research/web-fetch'
import { safePathWithin } from '$lib/workspace/workspace.server'
import { guardedDownload } from './egress.server'
import { ensureWorkspaceDir, getWorkspace, gotoGuarded, readPageText, toolUserContext, withBrowserPage } from './sandbox.server'

/**
 * Wave 4 #18 phase 1 — `web_fetch` tool implementation.
 *
 * Loads the page in its own browser context (closed afterwards, so concurrent calls from
 * different runs never share a page) and returns the body text trimmed to maxChars.
 *
 * SAFETY: `gotoGuarded` checks the URL and its DNS answers before navigating, and the
 * browser itself sits behind the egress proxy, so redirects and subresources that point at
 * private addresses are refused too. The navigate has a 30s timeout — sites that hang past
 * that fail rather than tying up the worker indefinitely.
 *
 * Boilerplate strip + paragraph-boundary truncation are pure helpers in `$lib/research/web-fetch`.
 */
export async function webFetch(rawUrl: string, maxChars = 50_000) {
	return withBrowserPage(async (p) => {
		await gotoGuarded(p, rawUrl)
		// Best-effort: also wait for network to settle briefly so SPA pages have time to render.
		await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
		return pageTextResult(p, maxChars)
	})
}

/**
 * How much raw body text is read for each character `web_fetch` returns. Raw text is full of
 * indentation and blank lines that the cleanup collapses, so reading exactly `maxChars` would
 * come up short; ten times over leaves room for that and still bounds what reaches the server
 * (a million characters at the largest `maxChars`).
 */
export const RAW_TEXT_FACTOR = 10

/**
 * `web_fetch`'s result for a page that has already loaded. Only a bounded slice of the body
 * text ever leaves the browser (`readPageText`), however large the page is.
 */
export async function pageTextResult(page: Page, maxChars: number) {
	const url = page.url()
	const read = await readPageText(page, maxChars * RAW_TEXT_FACTOR).catch(() => ({ title: '', text: '', totalChars: 0 }))
	const cleaned = cleanupExtractedText(read.text)
	const readAll = read.totalChars <= read.text.length

	return {
		title: read.title,
		url,
		text: truncateAtParagraph(cleaned, maxChars),
		fetchedAt: new Date().toISOString(),
		// When the read stopped short, the rest was never cleaned, so the raw length is the
		// honest figure for how much there was.
		fullCharCount: readAll ? cleaned.length : read.totalChars,
		truncated: !readAll || cleaned.length > maxChars,
	}
}

/** Largest PDF `pdf_read` will download. Anything bigger is refused before or while reading. */
export const PDF_MAX_BYTES = 50 * 1024 * 1024
const PDF_DOWNLOAD_TIMEOUT_MS = 45_000
/** pdftotext gets this long per file before it is killed. */
const PDFTOTEXT_TIMEOUT_MS = 60_000
/**
 * Text collected from pdftotext before it is stopped. Far above the largest `maxChars`, so it
 * only bites on pathological files — and it keeps one of those from filling the heap.
 */
const PDFTOTEXT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** Only the start of pdftotext's stderr ever reaches an error message. */
const PDFTOTEXT_MAX_STDERR_BYTES = 4 * 1024

function runPdftotext(pdfPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const proc = spawn('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		const out: Buffer[] = []
		let outBytes = 0
		let capped = false
		let timedOut = false
		const err: Buffer[] = []
		let errBytes = 0
		const timer = setTimeout(() => {
			timedOut = true
			proc.kill('SIGKILL')
		}, PDFTOTEXT_TIMEOUT_MS)
		proc.stdout.on('data', (chunk: Buffer) => {
			if (capped) return
			const room = PDFTOTEXT_MAX_OUTPUT_BYTES - outBytes
			if (chunk.length >= room) {
				out.push(chunk.subarray(0, room))
				outBytes = PDFTOTEXT_MAX_OUTPUT_BYTES
				capped = true
				proc.kill('SIGKILL')
				return
			}
			out.push(chunk)
			outBytes += chunk.length
		})
		proc.stderr.on('data', (chunk: Buffer) => {
			if (errBytes >= PDFTOTEXT_MAX_STDERR_BYTES) return
			err.push(chunk)
			errBytes += chunk.length
		})
		proc.on('error', (e) => {
			clearTimeout(timer)
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
			clearTimeout(timer)
			// Stopped at the output cap: what we have is already far more than maxChars.
			if (capped || code === 0) resolve(Buffer.concat(out).toString('utf8'))
			else if (timedOut) reject(new Error(`pdftotext timed out after ${PDFTOTEXT_TIMEOUT_MS / 1000}s`))
			else
				reject(
					new Error(`pdftotext exited with code ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`),
				)
		})
	})
}

/**
 * Wave 4 #18 phase 5 — `pdf_read` tool implementation.
 *
 * Shells out to `pdftotext` (poppler-utils, available in most Linux/macOS dev environments
 * + the production Docker image). Accepts either:
 *   - HTTP(S) URL — streamed to a temp file through the egress guard, then run through pdftotext
 *   - Absolute path inside the user's sandbox workspace — used directly
 *
 * The download goes through `guardedDownload`: public addresses only (every redirect hop
 * re-checked), at most PDF_MAX_BYTES, one 45s deadline. Path validation uses safePathWithin
 * so an agent can't traverse out of its sandbox via `../`.
 *
 * Returns the extracted text trimmed to maxChars at the nearest paragraph boundary. When
 * pdftotext is missing, returns a structured error with install instructions instead of
 * crashing the run.
 *
 * `lookup` is a test seam, as on `guardedDownload`: production callers leave it unset so every
 * hop resolves through the real policy; a spec sets it to reach a fixture server on loopback.
 */
export async function pdfRead(
	rawSource: string,
	maxChars = 100_000,
	lookup?: LookupFunction,
): Promise<{
	source: string
	text: string
	charCount: number
	truncated: boolean
	pageHint: number | null
}> {
	const trimmed = rawSource.trim()
	let tempDir: string | null = null
	let resolvedSource = trimmed

	try {
		let pdfPath: string
		if (/^https?:\/\//i.test(trimmed)) {
			tempDir = await mkdtemp(join(tmpdir(), 'pdf-read-'))
			pdfPath = join(tempDir, 'source.pdf')
			const download = await guardedDownload(trimmed, pdfPath, {
				maxBytes: PDF_MAX_BYTES,
				timeoutMs: PDF_DOWNLOAD_TIMEOUT_MS,
				headers: { accept: 'application/pdf,*/*;q=0.8' },
				lookup,
			})
			if (download.status < 200 || download.status >= 300) {
				throw new Error(`failed to download PDF: HTTP ${download.status}`)
			}
			resolvedSource = download.url.toString()
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

		const stdout = await runPdftotext(pdfPath)
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
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
		}
	}
}
