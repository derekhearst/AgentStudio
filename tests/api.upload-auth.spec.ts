import { readdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'
import { getUploadDir } from '../src/lib/server/config'

/**
 * `/api/upload` requires a session — in the handler, not only in the hook.
 *
 * Read on its own, the POST handler looks like an open upload endpoint: it took a file and
 * wrote it to disk without ever consulting `locals.user`. It was not open. `hooks.server.ts`
 * redirects every unauthenticated request whose path is not in `PUBLIC_PATH_PREFIXES`, and
 * `/api/upload` is not in that list, so an anonymous POST answered `303 → /login` and never
 * reached the handler. Checked by running it against the unpatched code, not by reading.
 *
 * So the handler checks are defence in depth: they make the guarantee independent of a list
 * in another file. Adding `/api` to `PUBLIC_PATH_PREFIXES` for some future public endpoint
 * would otherwise open this one silently, and an endpoint that writes 20MB per call
 * (100MB for video) should not be one edit away from anonymous.
 *
 * A consequence for these tests: the hook answers first, so an anonymous request is
 * observably refused but *which* layer refused it is not. That is why the anonymous cases
 * assert the refusal and the absence of a side effect rather than a specific status — the
 * handler's own 401 is genuinely unreachable from outside, which is the point of it.
 *
 * Session checks, not per-file ownership: nothing in the schema says who owns an upload,
 * and inventing that is a migration rather than a fix.
 */

const PNG = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
	'hex',
)

async function uploadDirNames(): Promise<string[]> {
	try {
		return await readdir(getUploadDir())
	} catch {
		return []
	}
}

test.describe('api/upload — the session check', () => {
	test('an anonymous upload is refused before anything is written', async ({ playwright }) => {
		const before = await uploadDirNames()
		const context = await playwright.request.newContext()
		try {
			const response = await context.post('/api/upload', {
				multipart: { file: { name: 'anon.png', mimeType: 'image/png', buffer: PNG } },
				maxRedirects: 0,
			})
			// 303 in practice — the hook's redirect to /login — with 401 allowed so this keeps
			// passing if the handler ever becomes the first thing to answer.
			expect([401, 302, 303]).toContain(response.status())
		} finally {
			await context.dispose()
		}
		// The assertion that does not depend on which layer refused: nothing was written.
		expect(await uploadDirNames()).toEqual(before)
	})

	test('an anonymous read of an existing upload is refused', async ({ page, playwright }) => {
		await authenticateContext(page.context())
		const uploaded = await page.request.post('/api/upload', {
			multipart: { file: { name: 'private.png', mimeType: 'image/png', buffer: PNG } },
		})
		expect(uploaded.status()).toBe(200)
		const { url } = (await uploaded.json()) as { url: string }

		const context = await playwright.request.newContext()
		try {
			const response = await context.get(url, { maxRedirects: 0 })
			expect([401, 302, 303]).toContain(response.status())
		} finally {
			await context.dispose()
		}
	})

	test('a signed-in upload still round-trips, and is not publicly cacheable', async ({ page }) => {
		// The round-trip matters more than the refusals here: adding a check to a handler
		// that had none is exactly the change that breaks the path everyone actually uses.
		await authenticateContext(page.context())

		const uploaded = await page.request.post('/api/upload', {
			multipart: { file: { name: 'ok.png', mimeType: 'image/png', buffer: PNG } },
		})
		expect(uploaded.status()).toBe(200)
		const attachment = (await uploaded.json()) as { url: string; filename: string; mimeType: string }
		expect(attachment.filename).toBe('ok.png')
		expect(attachment.url).toMatch(/^\/api\/upload\/[A-Za-z0-9-]+\.png$/)

		const fetched = await page.request.get(attachment.url)
		expect(fetched.status()).toBe(200)
		expect(fetched.headers()['content-type']).toBe('image/png')
		// Independent of the auth change: this response has always required a session, via
		// the hook, so `public` was already wrong — a shared cache is entitled to keep a
		// `public` response and serve it to a different, unauthenticated request.
		expect(fetched.headers()['cache-control']).toContain('private')
		expect(fetched.headers()['cache-control']).not.toContain('public')
	})

	test('the existing refusals still come first for a signed-in caller', async ({ page }) => {
		// Adding the session check must not have reordered the type gate into unreachability.
		await authenticateContext(page.context())
		const response = await page.request.post('/api/upload', {
			multipart: { file: { name: 'payload.bin', mimeType: 'application/x-msdownload', buffer: PNG } },
		})
		expect(response.status()).toBe(400)
		expect((await response.json()).error).toContain('Unsupported file type')
	})
})
