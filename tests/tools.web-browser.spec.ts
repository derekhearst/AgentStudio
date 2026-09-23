/**
 * The web tools end to end: web_fetch, browser_screenshot and pdf_read on top of the egress
 * guard, and the headless browser they share.
 *
 * No database and no internet. Real Chromium, launched the way the app launches it
 * (`browserLaunchOptions`), behind an egress proxy whose lookup can reach the loopback
 * fixture in `egress-fixture.ts`; every other name goes through the real policy.
 *
 * What is pinned:
 *   - #36: browser_screenshot validates its URL like web_fetch does — no file://, loopback,
 *     metadata or mapped-IPv6 targets — and requires one
 *   - #37 / #90: the tools refuse private targets before anything is sent, and inside the
 *     browser a redirect, a subresource or a page script cannot reach one either
 *   - #38: every call gets its own browser context, closed afterwards; concurrent calls
 *     never see each other's page or cookies
 *   - #43: pdf_read's download is capped
 *   - web_fetch reads only a bounded slice of a page's text out of the browser, however big
 *     the page makes it and whatever its scripts do to stop that
 */

import { expect, test } from '@playwright/test'
import { chromium, type Browser } from 'playwright'
import { toolSchemas } from '../src/lib/tools/tool-schemas'
import {
	createEgressProxy,
	EGRESS_REFUSAL_HEADER,
	EgressBlockedError,
	type EgressProxy,
} from '../src/lib/tools/egress.server'
import {
	browserClose,
	browserLaunchOptions,
	browserScreenshot,
	gotoGuarded,
	readPageText,
	withBrowserPage,
} from '../src/lib/tools/sandbox-browser.server'
import { PDF_MAX_BYTES, pageTextResult, pdfRead, RAW_TEXT_FACTOR, webFetch } from '../src/lib/tools/web-fetch.server'
import { fixtureLookup, startFixture, type Fixture } from './egress-fixture'

let fixture: Fixture

test.beforeAll(async () => {
	fixture = await startFixture()
})

test.afterAll(async () => {
	await browserClose()
	await fixture.close()
})

test.beforeEach(() => {
	fixture.reset()
})

test.describe('web tools refuse private targets before sending anything', () => {
	const privateTargets = () => [
		'file:///etc/passwd',
		`http://127.0.0.1:${fixture.port}/secret`,
		`http://localhost.:${fixture.port}/secret`,
		`http://[::ffff:127.0.0.1]:${fixture.port}/secret`,
		`http://[::]:${fixture.port}/secret`,
		'http://169.254.169.254/latest/meta-data/',
		'http://100.100.100.200/latest/meta-data/',
	]

	test('browser_screenshot', async () => {
		for (const url of privateTargets()) {
			await expect(browserScreenshot(url), url).rejects.toThrow(/Blocked|unsupported protocol/)
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('web_fetch', async () => {
		for (const url of privateTargets()) {
			await expect(webFetch(url), url).rejects.toThrow(/Blocked|unsupported protocol/)
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('pdf_read', async () => {
		for (const url of privateTargets().filter((u) => u.startsWith('http'))) {
			await expect(pdfRead(url), url).rejects.toBeInstanceOf(EgressBlockedError)
		}
		expect(fixture.hits('/secret')).toBe(0)
	})

	test('pdf_read caps downloads at 50 MB', () => {
		expect(PDF_MAX_BYTES).toBe(50 * 1024 * 1024)
	})

	test('browser_screenshot requires a URL — there is no shared "current page" to capture', () => {
		expect(toolSchemas.browser_screenshot.safeParse({}).success).toBe(false)
		expect(toolSchemas.browser_screenshot.safeParse({ url: 'https://example.com' }).success).toBe(true)
	})
})

test.describe('each browser call is isolated', () => {
	test('concurrent calls get separate pages and cookie jars, closed afterwards', async () => {
		const calls = await Promise.all(
			[0, 1].map((i) =>
				withBrowserPage(async (page) => {
					await page.setContent(`<p id="who">caller ${i}</p>`)
					await page.context().addCookies([{ name: 'who', value: String(i), url: 'https://example.com' }])
					// Overlap the two calls, the way two runs' web_fetch calls overlap in production.
					await new Promise((resolve) => setTimeout(resolve, 250))
					return {
						page,
						text: await page.textContent('#who'),
						cookies: (await page.context().cookies()).map((c) => c.value),
					}
				}),
			),
		)
		expect(calls[0].text).toBe('caller 0')
		expect(calls[1].text).toBe('caller 1')
		expect(calls[0].cookies).toEqual(['0'])
		expect(calls[1].cookies).toEqual(['1'])
		expect(calls[0].page).not.toBe(calls[1].page)
		expect(calls[0].page.isClosed()).toBe(true)
		expect(calls[1].page.isClosed()).toBe(true)

		// Nothing a site set during one call is there for the next.
		const later = await withBrowserPage(async (page) => (await page.context().cookies()).length)
		expect(later).toBe(0)
	})

	test('the context is closed even when the call throws', async () => {
		let seen: import('playwright').Page | null = null
		await expect(
			withBrowserPage(async (page) => {
				seen = page
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(seen!.isClosed()).toBe(true)
	})
})

test.describe('only a bounded slice of a page leaves the browser', () => {
	// A page that grows its body past seven million characters — five million x's, then two
	// million newlines that cleanup would collapse to two — and then does what it can to make
	// the reader take all of it: every slicing method returns the whole string, and the main
	// world's textContent getter returns ten million characters of its own.
	const HOSTILE_PAGE = `<title>${'T'.repeat(5_000)}</title><body><p>start of the page</p><script>
		document.body.appendChild(document.createTextNode('x'.repeat(5_000_000) + String.fromCharCode(10).repeat(2_000_000)));
		String.prototype.slice = function () { return String(this) };
		String.prototype.substring = function () { return String(this) };
		String.prototype.substr = function () { return String(this) };
		Object.defineProperty(Node.prototype, 'textContent', { get() { return 'y'.repeat(10_000_000) } });
	</script></body>`

	test("the body text and title are cut to size in the page, whatever the page's scripts do", async () => {
		const read = await withBrowserPage(async (page) => {
			await page.setContent(HOSTILE_PAGE)
			return readPageText(page, 1_000)
		})
		expect(read.text).toHaveLength(1_000)
		expect(read.text).toContain('start of the page')
		// The real DOM, not the main world's fake getter.
		expect(read.text).not.toMatch(/y{100}/)
		expect(read.totalChars).toBeGreaterThan(7_000_000)
		expect(read.totalChars).toBeLessThan(10_000_000)
		expect(read.title).toHaveLength(1_000)
	})

	test('web_fetch reads at most RAW_TEXT_FACTOR × maxChars and says it was cut', async () => {
		const result = await withBrowserPage(async (page) => {
			await page.setContent(HOSTILE_PAGE)
			return pageTextResult(page, 1_000)
		})
		expect(result.truncated).toBe(true)
		// The raw length, because the read stopped short. A read of the whole body would have
		// been cleaned first, collapsing the newlines, and reported about five million.
		expect(result.fullCharCount).toBeGreaterThan(7_000_000)
		// maxChars of text plus the one-line truncation note.
		expect(result.text.length).toBeLessThan(1_000 + 100)
		expect(result.text).toContain('start of the page')
		expect(RAW_TEXT_FACTOR * 1_000).toBeLessThan(5_000_000)
	})

	test('an ordinary page is read whole', async () => {
		const result = await withBrowserPage(async (page) => {
			await page.setContent('<title>Hello</title><body><h1>Heading</h1>\n\n<p>Some text.</p></body>')
			return pageTextResult(page, 1_000)
		})
		expect(result.title).toBe('Hello')
		expect(result.text).toBe('Heading\n\nSome text.')
		expect(result.truncated).toBe(false)
		expect(result.fullCharCount).toBe(result.text.length)
	})
})

test.describe('inside the browser, the egress proxy sees every request', () => {
	let proxy: EgressProxy
	let browser: Browser

	test.beforeAll(async () => {
		proxy = await createEgressProxy({ lookup: fixtureLookup })
		// Playwright adds `<-loopback>` to any proxy by itself unless this is set. Setting it
		// leaves our own `bypass` as the only thing sending loopback through the proxy, so the
		// loopback spec below fails if that is ever dropped.
		const forced = process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK
		process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1'
		try {
			browser = await chromium.launch(browserLaunchOptions(proxy.url))
		} finally {
			if (forced === undefined) delete process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK
			else process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = forced
		}
	})

	test.afterAll(async () => {
		await browser?.close()
		await proxy?.close()
	})

	test('a public page loads, but its subresources and scripts cannot reach private addresses', async () => {
		const page = await browser.newPage()
		try {
			await gotoGuarded(page, fixture.url('/page'), fixtureLookup)
			await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined)
			expect(await page.textContent('#text')).toBe('public page')
			expect(fixture.hits('/page')).toBe(1)
			expect(fixture.hits('/secret')).toBe(0)
		} finally {
			await page.close()
		}
	})

	test('a redirect to a private address is refused at the hop and surfaces as an error', async () => {
		const page = await browser.newPage()
		try {
			for (const path of ['/redirect-literal', '/redirect-mapped', '/redirect-intranet', '/redirect-metadata']) {
				await expect(gotoGuarded(page, fixture.url(path), fixtureLookup), path).rejects.toBeInstanceOf(EgressBlockedError)
			}
			expect(fixture.hits('/secret')).toBe(0)
		} finally {
			await page.close()
		}
	})

	test('loopback is not exempt from the proxy', async () => {
		// Chromium bypasses a proxy for localhost unless told otherwise (`<-loopback>`); without
		// that, this would load.
		const page = await browser.newPage()
		try {
			for (const url of [`http://127.0.0.1:${fixture.port}/secret`, `http://localhost:${fixture.port}/secret`]) {
				const response = await page.goto(url)
				expect(response?.status(), url).toBe(403)
				expect(await response?.headerValue(EGRESS_REFUSAL_HEADER), url).toBeTruthy()
			}
			expect(fixture.hits('/secret')).toBe(0)
		} finally {
			await page.close()
		}
	})
})
