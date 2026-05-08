import type { Browser, Page } from 'playwright'

/**
 * Headless-browser singleton used by `browser_screenshot` and any future browser-driven
 * tools. Lives here (not on `toolUserContext`) because the browser is process-wide:
 * spinning up a Chromium instance per tool call would be prohibitively slow, so all callers
 * share one Browser + reuse a single Page.
 *
 * The Page is recreated on demand if it was closed (e.g. by a navigation error). The
 * Browser is recreated if it disconnected.
 */

let browser: Browser | null = null
let page: Page | null = null

export async function getPage(): Promise<Page> {
	if (page && !page.isClosed()) return page

	if (!browser || !browser.isConnected()) {
		const { chromium } = await import('playwright')
		const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
		browser = await chromium.launch({
			headless: true,
			executablePath,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
		})
	}

	page = await browser.newPage()
	return page
}

export async function sandboxBrowserNavigate(url: string) {
	const p = await getPage()
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
	return { title: await p.title(), url: p.url() }
}

export async function sandboxBrowserScreenshot(): Promise<Buffer> {
	const p = await getPage()
	return (await p.screenshot({ type: 'png', fullPage: false })) as Buffer
}

export async function browserClose() {
	if (page && !page.isClosed()) {
		await page.close().catch(() => {})
	}
	page = null
	if (browser && browser.isConnected()) {
		await browser.close().catch(() => {})
	}
	browser = null
}
