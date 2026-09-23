import { expect, test, type Page, type Route } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedConversation,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { sse } from './chat-stream-script'

/**
 * #27 — reading replies aloud in the chat.
 *
 * `/api/tts` is answered in the browser with a generated WAV, so these specs spend nothing
 * and need no credential; what they check is what the page asks for and how it behaves.
 * The endpoint itself is pinned in api.tts.spec.ts and speech.tts-service.spec.ts.
 */

/** `seconds` of 8kHz mono silence — short enough to end quickly, long enough to catch. */
function silentWav(seconds: number): Buffer {
	const samples = Math.max(1, Math.round(8000 * seconds))
	const wav = Buffer.alloc(44 + samples, 0x80)
	wav.write('RIFF', 0)
	wav.writeUInt32LE(36 + samples, 4)
	wav.write('WAVE', 8)
	wav.write('fmt ', 12)
	wav.writeUInt32LE(16, 16)
	wav.writeUInt16LE(1, 20)
	wav.writeUInt16LE(1, 22)
	wav.writeUInt32LE(8000, 24)
	wav.writeUInt32LE(8000, 28)
	wav.writeUInt16LE(1, 32)
	wav.writeUInt16LE(8, 34)
	wav.write('data', 36)
	wav.writeUInt32LE(samples, 40)
	return wav
}

type SpeechRequest = { text: string; purpose?: string; model?: string; voice?: string }

/** Answer every `/api/tts` request with `answer`, recording what the page sent. */
async function scriptSpeech(page: Page, answer: (route: Route) => Promise<void>): Promise<SpeechRequest[]> {
	const seen: SpeechRequest[] = []
	await page.route(
		(url) => url.pathname === '/api/tts',
		async (route) => {
			seen.push(route.request().postDataJSON() as SpeechRequest)
			await answer(route)
		},
	)
	return seen
}

const wavAnswer = (seconds: number) => (route: Route) =>
	route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: silentWav(seconds) })

test('the speaker pill reads a reply without its code, and stops when pressed again', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, {
		userId: await getActiveUserId(),
		assistantMessage: `${prefix} Here is the fix.\n\n\`\`\`ts\nconst secret = 1\n\`\`\`\n\nRun **it** now.`,
	})
	// Long enough that it is still playing when the pill is pressed again.
	const requests = await scriptSpeech(page, wavAnswer(20))

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })

		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'playing', { timeout: 15_000 })
		expect(requests).toHaveLength(1)
		expect(requests[0].purpose).toBe('message')
		expect(requests[0].text).toContain('Here is the fix.')
		expect(requests[0].text).toContain('Code block omitted.')
		expect(requests[0].text).toContain('Run it now.')
		expect(requests[0].text).not.toContain('const secret')
		expect(requests[0].text).not.toContain('`')

		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 5_000 })
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('a long reply is fetched in order, a short piece first, and each piece under the cap', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud-long')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} carries on for a little while.`)
	const conv = await seedConversation(prefix, {
		userId: await getActiveUserId(),
		assistantMessage: `${prefix} ${sentences.join(' ')}`,
	})
	const requests = await scriptSpeech(page, wavAnswer(0.2))

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
		await pill.click()

		// Plays through every piece and comes back to idle.
		await expect.poll(() => requests.length, { timeout: 30_000 }).toBeGreaterThan(1)
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })

		const { SPEECH_CHUNK_CHARACTERS, SPEECH_FIRST_CHUNK_CHARACTERS } = await import('../src/lib/speech/speech')
		expect(requests[0].text.length).toBeLessThanOrEqual(SPEECH_FIRST_CHUNK_CHARACTERS)
		for (const request of requests) expect(request.text.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARACTERS)
		const spoken = requests.map((r) => r.text).join(' ')
		let from = 0
		for (const sentence of sentences) {
			const at = spoken.indexOf(sentence, from)
			expect(at, sentence).toBeGreaterThanOrEqual(from)
			from = at + sentence.length
		}
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('a refusal is shown on the pill, in the provider’s words', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud-error')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
	await scriptSpeech(page, (route) =>
		route.fulfill({
			status: 422,
			json: { message: 'The speech provider rejected the request: Unknown voice "zz".' },
		}),
	)

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'error', { timeout: 15_000 })
		await expect(pill).toHaveAttribute('title', /Unknown voice "zz"/)
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('auto-read speaks the reply a finished turn produced — only once switched on', async ({ page }) => {
	test.setTimeout(120_000)
	const prefix = uniquePrefix('chat-auto-read')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const sql = getSql()
	const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
	const requests = await scriptSpeech(page, wavAnswer(0.2))

	// Each send "runs" a turn: the reply is saved the way the stream route would save it, and
	// the stream says `done` with its id — so the page reloads the conversation and sees it.
	let turn = 0
	await page.route(
		(url) => url.pathname === `/chat/${conv.id}/stream`,
		async (route) => {
			turn += 1
			const sent = (route.request().postDataJSON() as { content?: string } | null)?.content ?? ''
			const reply = `${prefix} reply number ${turn}.`
			const [{ id }] = await sql<{ id: string }[]>`
				with u as (
					insert into messages (conversation_id, role, content, sequence)
					values (${conv.id}, 'user', ${sent}, ${turn * 2 + 1})
				)
				insert into messages (conversation_id, role, content, sequence)
				values (${conv.id}, 'assistant', ${reply}, ${turn * 2 + 2})
				returning id
			`
			await route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				body: sse([
					{ id: 1, event: 'delta', data: { content: reply } },
					{ id: 2, event: 'done', data: { messageId: id } },
				]),
			})
		},
	)

	const send = async (text: string) => {
		const composer = page.getByPlaceholder('Message AgentStudio...')
		await composer.waitFor({ state: 'visible', timeout: 30_000 })
		await composer.fill(text)
		await page.getByRole('button', { name: /send message/i }).first().click()
	}
	const toggle = page.getByTestId('auto-read-toggle')

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		await expect(toggle).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 })

		// Off (the default): the turn finishes and nothing is read.
		await send(`${prefix} first`)
		await expect(page.getByText(`${prefix} reply number 1.`).first()).toBeVisible({ timeout: 30_000 })
		// The turn is over once the composer offers Send again instead of Stop.
		await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, { timeout: 30_000 })
		await page.waitForTimeout(1_000)
		expect(requests).toHaveLength(0)

		// On: the next reply is read when its turn ends — that reply only, not the history.
		await toggle.click()
		await expect(toggle).toHaveAttribute('aria-pressed', 'true')
		await send(`${prefix} second`)
		await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1)
		expect(requests[0].purpose).toBe('autoplay')
		expect(requests[0].text).toContain('reply number 2.')
		expect(requests[0].text).not.toContain('reply number 1.')

		// The switch is remembered on this device.
		await page.reload({ waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		await expect(page.getByTestId('auto-read-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})
