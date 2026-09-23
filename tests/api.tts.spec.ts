import { expect, test } from '@playwright/test'
import { authenticateContext } from './helpers'

/**
 * #27 — `/api/tts` refuses what it should before anything is paid for.
 *
 * Every case here is answered by the route itself — none reaches OpenRouter, so the spec
 * spends nothing with or without a model credential. What the service does once a request
 * is valid (the ledger, provider errors, budget limits) is pinned in
 * speech.tts-service.spec.ts, against a stubbed provider.
 */

test.describe('api/tts — refusals', () => {
	test('an anonymous request is refused', async ({ playwright }) => {
		const context = await playwright.request.newContext()
		try {
			const response = await context.post('/api/tts', { data: { text: 'Hello.' }, maxRedirects: 0 })
			// The hook redirects to /login before the handler's own 401 can answer.
			expect([401, 302, 303]).toContain(response.status())
		} finally {
			await context.dispose()
		}
	})

	test('only JSON is accepted', async ({ page }) => {
		await authenticateContext(page.context())
		const response = await page.request.post('/api/tts', {
			headers: { 'content-type': 'text/plain' },
			data: JSON.stringify({ text: 'Hello.' }),
		})
		expect(response.status()).toBe(415)
		expect((await response.json()).message).toContain('JSON')

		const broken = await page.request.post('/api/tts', {
			headers: { 'content-type': 'application/json' },
			data: '{"text": ',
		})
		expect(broken.status()).toBe(400)
		expect((await broken.json()).message).toContain('not valid JSON')
	})

	test('text must be present and within the per-request cap', async ({ page }) => {
		await authenticateContext(page.context())
		const { TTS_MAX_CHARACTERS } = await import('../src/lib/speech/speech')

		for (const text of ['', '   \n  ']) {
			const response = await page.request.post('/api/tts', { data: { text } })
			expect(response.status(), JSON.stringify(text)).toBe(400)
			expect((await response.json()).message).toBe('There is no text to read aloud.')
		}

		const tooLong = await page.request.post('/api/tts', { data: { text: 'x'.repeat(TTS_MAX_CHARACTERS + 1) } })
		expect(tooLong.status()).toBe(400)
		expect((await tooLong.json()).message).toContain(`${TTS_MAX_CHARACTERS} characters`)

		const missing = await page.request.post('/api/tts', { data: {} })
		expect(missing.status()).toBe(400)
	})

	test('a model or voice override must look like one', async ({ page }) => {
		await authenticateContext(page.context())
		const badModel = await page.request.post('/api/tts', { data: { text: 'Hi.', model: 'not a model' } })
		expect(badModel.status()).toBe(400)
		expect((await badModel.json()).message).toContain('OpenRouter model id')

		const badVoice = await page.request.post('/api/tts', { data: { text: 'Hi.', voice: '<script>' } })
		expect(badVoice.status()).toBe(400)
		expect((await badVoice.json()).message).toContain('voice name')

		const badPurpose = await page.request.post('/api/tts', { data: { text: 'Hi.', purpose: 'exfiltrate' } })
		expect(badPurpose.status()).toBe(400)
	})
})
