import type { LookupFunction } from 'node:net'
import type { Browser, LaunchOptions, Page } from 'playwright'
import { assertPublicUrl, EGRESS_REFUSAL_HEADER, EgressBlockedError, ensureEgressProxy, guardedLookup } from './egress.server'

/**
 * Headless Chromium for `web_fetch` and `browser_screenshot`.
 *
 * One Browser process is shared, because launching Chromium per call would cost seconds. The
 * page is not: every call gets its own BrowserContext — its own cookies, storage, cache and
 * tab — which is closed when the call ends. Two users' calls can run at the same time
 * without either seeing the other's page, and nothing a site set during one call is still
 * there for the next.
 *
 * The browser is launched behind the egress proxy (`egress.server.ts`). Every request it
 * makes — the first navigation, each redirect hop, subresources, whatever the page's own
 * scripts fetch — is checked there against the same public-internet-only rule as `pdf_read`.
 * Checking only the URL we were handed would miss all of those.
 */

let browser: Browser | null = null
let launching: Promise<Browser> | null = null

const NAVIGATION_TIMEOUT_MS = 30_000

/** How the shared browser is launched: behind `proxyUrl`, with no way around it. Exported for the spec. */
export function browserLaunchOptions(proxyUrl: string): LaunchOptions {
	return {
		headless: true,
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
		// `<-loopback>` removes Chromium's built-in proxy exemption for localhost, so loopback
		// requests go through the proxy — and are refused there — like everything else.
		// Playwright adds it too, unless PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK is
		// set; naming it here keeps the guard from depending on that variable.
		proxy: { server: proxyUrl, bypass: '<-loopback>' },
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			// WebRTC can send UDP straight to any address a page names, around the proxy.
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
		],
	}
}

async function launchBrowser(): Promise<Browser> {
	const [{ chromium }, proxy] = await Promise.all([import('playwright'), ensureEgressProxy()])
	const launched = await chromium.launch(browserLaunchOptions(proxy.url))
	launched.on('disconnected', () => {
		if (browser === launched) browser = null
	})
	browser = launched
	return launched
}

async function getBrowser(): Promise<Browser> {
	if (browser?.isConnected()) return browser
	// Concurrent first calls share one launch instead of racing to start two Chromiums.
	launching ??= launchBrowser().finally(() => {
		launching = null
	})
	return launching
}

/**
 * Run `fn` against a fresh page in a fresh, throwaway browser context. The context is closed
 * however `fn` ends, so nothing it loaded outlives the call.
 */
export async function withBrowserPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
	const context = await (await getBrowser()).newContext({
		acceptDownloads: false,
		serviceWorkers: 'block',
	})
	try {
		return await fn(await context.newPage())
	} finally {
		await context.close().catch(() => undefined)
	}
}

/**
 * Navigate through the guard. The URL is checked (shape, then DNS) before the browser sees
 * it, so the model gets a precise refusal; anything the proxy refuses later — a redirect to
 * a private address, say — is turned back into an error rather than returned as page text.
 *
 * `lookup` is a test seam for the pre-check only; the proxy the page's browser was launched
 * behind decides what is actually fetched.
 */
export async function gotoGuarded(page: Page, rawUrl: string, lookup: LookupFunction = guardedLookup): Promise<void> {
	const url = await assertPublicUrl(rawUrl, lookup)
	let response: Awaited<ReturnType<Page['goto']>>
	try {
		response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		// HTTPS goes through a CONNECT tunnel, and Chromium never shows a proxy's reply to one.
		if (message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
			throw new Error(
				`could not load ${url.href}: it (or a redirect it followed) points at an address the egress guard refuses, or the host is unreachable`,
			)
		}
		throw err
	}
	const refused = response ? await response.headerValue(EGRESS_REFUSAL_HEADER) : null
	if (refused) throw new EgressBlockedError(`could not load ${url.href}: ${refused}`)
}

const PAGE_READ_TIMEOUT_MS = 10_000
/** A title is a line of text; anything longer than this is a page playing games. */
const TITLE_MAX_CHARS = 1_000

export type PageText = {
	title: string
	/** The first `maxChars` of the body's text. */
	text: string
	/** The body text's full length, of which `text` is the start. */
	totalChars: number
}

/**
 * The page's title and the start of its body text, cut to size inside the browser.
 *
 * `page.textContent('body')` and `page.title()` copy the whole string over CDP into the
 * server's heap before anything can trim it, and a page — or a script on it — can make either
 * one hundreds of megabytes. Here only the slice leaves the browser.
 *
 * The read runs in an isolated world: its own JavaScript realm over the same DOM. The page's
 * scripts cannot reach into it, so they cannot replace `String.prototype.slice` or the
 * `textContent` getter to send the whole string after all — which they can do to anything
 * `page.evaluate` runs.
 */
export async function readPageText(page: Page, maxChars: number): Promise<PageText> {
	const cdp = await page.context().newCDPSession(page)
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const read = (async () => {
			const { frameTree } = await cdp.send('Page.getFrameTree')
			const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
				frameId: frameTree.frame.id,
				worldName: 'agentstudio-read',
			})
			const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
				executionContextId,
				functionDeclaration: `function (maxChars, titleMax) {
					const text = (document.body && document.body.textContent) || ''
					return { title: String(document.title).slice(0, titleMax), text: text.slice(0, maxChars), totalChars: text.length }
				}`,
				arguments: [{ value: Math.max(0, Math.floor(maxChars)) }, { value: TITLE_MAX_CHARS }],
				returnByValue: true,
			})
			if (exceptionDetails) throw new Error(`could not read the page: ${exceptionDetails.text}`)
			return result.value as PageText
		})()
		// A page stuck in a script loop never answers; the context closing afterwards ends it.
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`reading the page timed out after ${PAGE_READ_TIMEOUT_MS / 1000}s`)), PAGE_READ_TIMEOUT_MS)
		})
		return await Promise.race([read, deadline])
	} finally {
		clearTimeout(timer)
		await cdp.detach().catch(() => undefined)
	}
}

/** Load `url` in a throwaway context and capture the viewport as a PNG. */
export async function browserScreenshot(rawUrl: string): Promise<{ url: string; title: string; image: Buffer }> {
	return withBrowserPage(async (page) => {
		await gotoGuarded(page, rawUrl)
		const image = await page.screenshot({ type: 'png', fullPage: false })
		const { title } = await readPageText(page, 0).catch(() => ({ title: '' }))
		return { url: page.url(), title, image }
	})
}

export async function browserClose() {
	const current = browser ?? (launching ? await launching.catch(() => null) : null)
	browser = null
	if (current?.isConnected()) {
		await current.close().catch(() => {})
	}
}
