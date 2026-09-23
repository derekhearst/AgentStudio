import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, pollDb } from './helpers'

/**
 * #27 — the server half of read-aloud: `synthesizeSpeech` in `$lib/llm/tts.server`.
 *
 * Runs in the worker with `fetch` replaced, so nothing here reaches OpenRouter or spends
 * anything. What it pins, each of which was wrong or missing before:
 *   - a successful call is recorded in the ledger under `tts`, priced from the speech
 *     catalogue (OpenRouter sends no cost header for speech, so the old header-only path
 *     always recorded zero);
 *   - a provider refusal comes back as a status and a message the user can act on — the
 *     provider's own "Unknown voice …" — instead of a bare "TTS failed";
 *   - empty or over-long text, a missing key, and a blocking budget limit are refused
 *     before any upstream call is made.
 */

const PRICE_PER_CHARACTER = 0.00001
const CATALOGUE = {
	data: [{ id: 'e2e/speech', name: 'E2E Speech', pricing: { prompt: String(PRICE_PER_CHARACTER) }, supported_voices: ['v1'] }],
}

type SpeechCall = { body: Record<string, unknown> }

/** Replace `fetch`: the catalogue answers from CATALOGUE, speech from `speech()`. */
function stubOpenRouter(speech: () => Response | Promise<Response>): { calls: SpeechCall[]; restore: () => void } {
	const realFetch = globalThis.fetch
	const calls: SpeechCall[] = []
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
		if (url.includes('/models?output_modalities=speech')) return Response.json(CATALOGUE)
		if (url.endsWith('/audio/speech')) {
			calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
			return speech()
		}
		return realFetch(input, init)
	}) as typeof fetch
	return { calls, restore: () => (globalThis.fetch = realFetch) }
}

function audio(generationId: string): Response {
	return new Response(new Uint8Array([0xff, 0xf3, 0x64, 0xc4]), {
		status: 200,
		headers: { 'content-type': 'audio/mpeg', 'x-generation-id': generationId },
	})
}

/*
 * Every synthesis checks the user's budget limits, which are shared with the budget specs —
 * and with this file's own budget test running in the other project. Take their lock for
 * each test, so a $0 cap seeded elsewhere cannot refuse a synthesis here.
 */
let previousKey: string | undefined
let releaseBudgetLock: (() => Promise<void>) | null = null
test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
	previousKey = process.env.OPENROUTER_API_KEY
	// Any non-empty value: fetch is stubbed, so the key never leaves the process.
	process.env.OPENROUTER_API_KEY = previousKey?.trim() || 'e2e-placeholder'
})
test.afterEach(async () => {
	if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
	else process.env.OPENROUTER_API_KEY = previousKey
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

test('a synthesis is sent as MP3 with the chosen voice, and recorded under tts at the catalogue price', async () => {
	const { synthesizeSpeech } = await import('../src/lib/llm/tts.server')
	const userId = await getActiveUserId()
	const sql = getSql()
	const generationId = `gen-e2e-${randomUUID()}`
	const stub = stubOpenRouter(() => audio(generationId))
	try {
		const result = await synthesizeSpeech({ text: '  Hello there.  ', model: 'e2e/speech', voice: 'v1', userId, purpose: 'message' })
		expect(result.audio.byteLength).toBe(4)
		expect(result.contentType).toBe('audio/mpeg')
		expect(result.characters).toBe('Hello there.'.length)
		expect(stub.calls).toEqual([
			{ body: { model: 'e2e/speech', input: 'Hello there.', voice: 'v1', response_format: 'mp3' } },
		])

		const [row] = await pollDb(
			() => sql<{ source: string; model: string; tokens_in: number; cost: string; user_id: string; metadata: Record<string, unknown> }[]>`
				select source, model, tokens_in, cost, user_id, metadata from llm_usage where metadata->>'generationId' = ${generationId}
			`,
			(rows) => rows.length === 1,
			{ description: 'the tts ledger row' },
		)
		expect(row.source).toBe('tts')
		expect(row.model).toBe('e2e/speech')
		expect(row.user_id).toBe(userId)
		expect(row.tokens_in).toBe(12)
		expect(Number(row.cost)).toBeCloseTo(12 * PRICE_PER_CHARACTER, 12)
		expect(row.metadata).toMatchObject({ unit: 'characters', characters: 12, voice: 'v1', purpose: 'message', priced: true })
	} finally {
		stub.restore()
		await sql`delete from llm_usage where metadata->>'generationId' = ${generationId}`
	}
})

test('an empty voice is left out, and a model the catalogue does not price is recorded as unpriced', async () => {
	const { synthesizeSpeech } = await import('../src/lib/llm/tts.server')
	const userId = await getActiveUserId()
	const sql = getSql()
	const generationId = `gen-e2e-${randomUUID()}`
	const stub = stubOpenRouter(() => audio(generationId))
	try {
		await synthesizeSpeech({ text: 'Hi.', model: 'e2e/unlisted', voice: '  ', userId })
		expect(stub.calls[0].body).toEqual({ model: 'e2e/unlisted', input: 'Hi.', response_format: 'mp3' })
		const [row] = await pollDb(
			() => sql<{ cost: string; metadata: Record<string, unknown> }[]>`
				select cost, metadata from llm_usage where metadata->>'generationId' = ${generationId}
			`,
			(rows) => rows.length === 1,
			{ description: 'the unpriced tts ledger row' },
		)
		expect(Number(row.cost)).toBe(0)
		expect(row.metadata).toMatchObject({ priced: false, voice: null })
	} finally {
		stub.restore()
		await sql`delete from llm_usage where metadata->>'generationId' = ${generationId}`
	}
})

test('provider refusals become a status and a message the user can act on', async () => {
	const { synthesizeSpeech, TtsError } = await import('../src/lib/llm/tts.server')
	const cases: Array<{ answer: () => Response | Promise<Response>; status: number; message: RegExp }> = [
		{
			answer: () => Response.json({ error: { message: 'Unknown voice "zz". Supported voices: v1', code: 400 } }, { status: 400 }),
			status: 422,
			message: /Unknown voice "zz"\. Supported voices: v1/,
		},
		{
			answer: () => Response.json({ error: { message: 'Model x/y does not exist', code: 400 } }, { status: 400 }),
			status: 422,
			message: /does not exist/,
		},
		{ answer: () => Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 }), status: 502, message: /API key/ },
		{ answer: () => Response.json({ error: { message: 'Insufficient credits' } }, { status: 402 }), status: 402, message: /Insufficient credits/ },
		{ answer: () => new Response('slow down', { status: 429 }), status: 429, message: /rate-limiting/ },
		{ answer: () => new Response('<html>oops</html>', { status: 503 }), status: 502, message: /HTTP 503/ },
		{ answer: () => new Response(new Uint8Array(), { status: 200 }), status: 502, message: /no audio/ },
		{
			answer: () => {
				throw new TypeError('fetch failed')
			},
			status: 502,
			message: /Could not reach/,
		},
	]
	for (const { answer, status, message } of cases) {
		const stub = stubOpenRouter(answer)
		try {
			const failure = await synthesizeSpeech({ text: 'Hi.', model: 'e2e/speech', voice: 'v1', userId: null }).then(
				() => null,
				(err: unknown) => err,
			)
			expect(failure, `expected HTTP ${status}`).toBeInstanceOf(TtsError)
			expect((failure as InstanceType<typeof TtsError>).status).toBe(status)
			expect((failure as Error).message).toMatch(message)
		} finally {
			stub.restore()
		}
	}
})

test('a listener who stops is a cancellation, not a provider failure', async () => {
	const { synthesizeSpeech } = await import('../src/lib/llm/tts.server')
	const stub = stubOpenRouter(() => audio('unused'))
	try {
		await expect(
			synthesizeSpeech({ text: 'Hi.', model: 'e2e/speech', userId: null, signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ status: 499 })
	} finally {
		stub.restore()
	}
})

test('empty text, over-long text and a missing key are refused before any upstream call', async () => {
	const { synthesizeSpeech } = await import('../src/lib/llm/tts.server')
	const { TTS_MAX_CHARACTERS } = await import('../src/lib/speech/speech')
	const stub = stubOpenRouter(() => audio('unused'))
	try {
		await expect(synthesizeSpeech({ text: ' \n ', model: 'e2e/speech', userId: null })).rejects.toMatchObject({ status: 400 })
		await expect(
			synthesizeSpeech({ text: 'x'.repeat(TTS_MAX_CHARACTERS + 1), model: 'e2e/speech', userId: null }),
		).rejects.toMatchObject({ status: 413 })
		process.env.OPENROUTER_API_KEY = ''
		await expect(synthesizeSpeech({ text: 'Hi.', model: 'e2e/speech', userId: null })).rejects.toMatchObject({
			status: 503,
			message: expect.stringContaining('OPENROUTER_API_KEY'),
		})
		expect(stub.calls).toEqual([])
	} finally {
		stub.restore()
	}
})

test('a blocking budget limit refuses speech before the provider is called', async () => {
	const { synthesizeSpeech } = await import('../src/lib/llm/tts.server')
	const userId = await getActiveUserId()
	const sql = getSql()
	const stub = stubOpenRouter(() => audio('unused'))
	let limitId: string | null = null
	try {
		const [limit] = await sql<{ id: string }[]>`
			insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
			values (${userId}, 'global', 'day', '0', 'block', true)
			returning id
		`
		limitId = limit.id
		// Any priced speech projects above a $0 cap, whatever else was spent today.
		await expect(synthesizeSpeech({ text: 'Hello there.', model: 'e2e/speech', userId })).rejects.toMatchObject({
			status: 402,
			message: expect.stringContaining('Budget limit reached'),
		})
		expect(stub.calls).toEqual([])
	} finally {
		stub.restore()
		if (limitId) await sql`delete from budget_limits where id = ${limitId}`
	}
})
