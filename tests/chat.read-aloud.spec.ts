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

type AudioProbe = {
	/** Every `play()` the page made, by what the element was playing. */
	plays: string[]
	/** Each `/api/tts` fetch, and whether it was cancelled before its answer arrived. */
	tts: Array<{ abortedWhilePending: boolean }>
}

/**
 * Watch the page's audio and its `/api/tts` fetches. With `blockReplyAudio`, `play()` of a
 * reply chunk (a blob: URL) is refused the way an autoplay policy refuses it; priming with the
 * silent data: WAV still plays.
 */
async function probeAudio(page: Page, options: { blockReplyAudio?: boolean } = {}) {
	await page.addInitScript((blockReplyAudio) => {
		const probe = { plays: [] as string[], tts: [] as Array<{ abortedWhilePending: boolean }> }
		const w = window as unknown as { __audioProbe: typeof probe; __speechAudio?: HTMLMediaElement }
		w.__audioProbe = probe
		const realPlay = HTMLMediaElement.prototype.play
		HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
			w.__speechAudio = this
			probe.plays.push(this.src)
			if (blockReplyAudio && this.src.startsWith('blob:')) {
				return Promise.reject(new DOMException('play() is not allowed without a user gesture.', 'NotAllowedError'))
			}
			return realPlay.call(this)
		}
		const realFetch = window.fetch
		window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
			const url = input instanceof Request ? input.url : String(input)
			if (!url.includes('/api/tts')) return realFetch.call(this, input, init)
			const entry = { abortedWhilePending: false }
			let answered = false
			probe.tts.push(entry)
			init?.signal?.addEventListener('abort', () => {
				if (!answered) entry.abortedWhilePending = true
			})
			try {
				return await realFetch.call(this, input, init)
			} finally {
				answered = true
			}
		}
	}, options.blockReplyAudio ?? false)
	return {
		read: () => page.evaluate(() => (window as unknown as { __audioProbe: AudioProbe }).__audioProbe),
		/** Make the element fail mid-chunk, as a decode error would. */
		failPlayback: () =>
			page.evaluate(() => (window as unknown as { __speechAudio?: HTMLMediaElement }).__speechAudio?.dispatchEvent(new Event('error'))),
	}
}

/** A reply several chunks long. */
function longReply(prefix: string): string {
	const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} carries on for a little while.`)
	return `${prefix} ${sentences.join(' ')}`
}

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

test('a reply started from its own pill can be stopped from above the composer', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud-stop-pill')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId(), assistantMessage: `${prefix} a reply to stop.` })
	await scriptSpeech(page, wavAnswer(20))

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		const stop = page.getByTestId('read-aloud-stop')
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
		await expect(stop).toHaveCount(0)

		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'playing', { timeout: 15_000 })
		// The pill's row fades out once the message loses hover; this button stays.
		await page.mouse.move(0, 0)
		await expect(stop).toBeVisible()
		await stop.click()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 5_000 })
		await expect(stop).toHaveCount(0)
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('a browser that refuses to play pays for the first chunk only', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud-blocked')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId(), assistantMessage: longReply(prefix) })
	const probe = await probeAudio(page, { blockReplyAudio: true })
	const requests = await scriptSpeech(page, wavAnswer(0.2))

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'error', { timeout: 15_000 })
		await expect(pill).toHaveAttribute('title', /blocked playback/)
		// The next chunk is asked for only once a chunk is audibly playing, and none ever was.
		await page.waitForTimeout(1_000)
		expect(requests).toHaveLength(1)
		expect((await probe.read()).plays.filter((src) => src.startsWith('blob:'))).toHaveLength(1)
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('a playback failure part-way cancels the chunk already requested for later', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud-fail-midway')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId(), assistantMessage: longReply(prefix) })
	const probe = await probeAudio(page)
	// The first chunk plays for a while; the next is never answered, so only a cancel ends it.
	let answered = 0
	const requests = await scriptSpeech(page, async (route) => {
		answered += 1
		if (answered === 1) return wavAnswer(20)(route)
		await new Promise<void>(() => undefined)
	})

	try {
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'playing', { timeout: 15_000 })
		await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2)

		await probe.failPlayback()
		await expect(pill).toHaveAttribute('data-state', 'error', { timeout: 5_000 })
		await expect.poll(async () => (await probe.read()).tts[1]?.abortedWhilePending, { timeout: 5_000 }).toBe(true)
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('opening another conversation stops a reply being read', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-read-aloud-leave')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const userId = await getActiveUserId()
	const first = await seedConversation(prefix, { userId, assistantMessage: `${prefix} first conversation reply.` })
	const second = await seedConversation(prefix, { userId, assistantMessage: `${prefix} second conversation reply.` })
	// Long enough to still be playing when we come back, had nothing stopped it.
	await scriptSpeech(page, wavAnswer(20))

	/** In-app navigation: the chat page is reused rather than reloaded, as from the sidebar. */
	const openInApp = async (id: string) => {
		await page.evaluate((href) => {
			const link = document.createElement('a')
			link.href = href
			document.body.appendChild(link)
			link.click()
			link.remove()
		}, `/chat/${id}`)
		await page.waitForURL(`**/chat/${id}`)
		await expect(page.getByText(`${prefix} ${id === first.id ? 'first' : 'second'} conversation reply.`).first()).toBeVisible({
			timeout: 30_000,
		})
	}

	try {
		await page.goto(`/chat/${first.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const pill = page.getByTestId('speak-button').filter({ visible: true }).first()
		await expect(pill).toHaveAttribute('data-state', 'idle', { timeout: 30_000 })
		await pill.click()
		await expect(pill).toHaveAttribute('data-state', 'playing', { timeout: 15_000 })

		// Its speaker button is gone from the screen, so nothing there could stop it any more.
		await openInApp(second.id)
		await openInApp(first.id)
		await expect(page.getByTestId('speak-button').filter({ visible: true }).first()).toHaveAttribute('data-state', 'idle', {
			timeout: 5_000,
		})
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
	const conv = await seedConversation(prefix, { userId: await getActiveUserId(), assistantMessage: longReply(prefix) })
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

test('with auto-read on, the first tap after a reload primes audio again', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-auto-read-reprime')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
	const probe = await probeAudio(page)
	const primes = async () => (await probe.read()).plays.filter((src) => src.startsWith('data:audio/wav')).length

	try {
		// Off: tapping around the page plays nothing.
		await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		const toggle = page.getByTestId('auto-read-toggle')
		const composer = page.getByPlaceholder('Message AgentStudio...')
		await expect(toggle).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 })
		await composer.click()
		expect(await primes()).toBe(0)

		// On, then a reload: the switch is remembered, the primed element is not. The next tap
		// primes it again, which is what lets the reply to that message be read without one.
		await toggle.click()
		await expect(toggle).toHaveAttribute('aria-pressed', 'true')
		await page.reload({ waitUntil: 'domcontentloaded' })
		await waitForHydration(page)
		await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
		expect(await primes()).toBe(0)
		await composer.click()
		await expect.poll(primes, { timeout: 5_000 }).toBeGreaterThan(0)
	} finally {
		await page.evaluate(() => localStorage.removeItem('agentstudio:speech:auto-read')).catch(() => undefined)
		await cleanupPrefixedRecords(prefix)
	}
})
