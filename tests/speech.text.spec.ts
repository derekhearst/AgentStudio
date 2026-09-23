/**
 * #27 — what read-aloud says, in what pieces, and for which replies.
 *
 * Pure — no database, no server. A reply is markdown written for the screen; read verbatim it
 * would recite code fences, table pipes and whole URLs. And the synthesis endpoint takes at
 * most TTS_MAX_CHARACTERS per request, so a long reply has to be cut — between sentences,
 * never losing or reordering a word, with a short first piece so playback starts quickly.
 */

import { expect, test } from '@playwright/test'
import {
	DEFAULT_TTS_MODEL,
	DEFAULT_TTS_VOICE,
	parseSpeechCatalog,
	repliesToSpeak,
	SPEECH_CHUNK_CHARACTERS,
	SPEECH_FIRST_CHUNK_CHARACTERS,
	SPEECH_MODEL_ID_PATTERN,
	SPEECH_VOICE_PATTERN,
	splitForSpeech,
	startTurn,
	toSpeakableText,
	TTS_MAX_CHARACTERS,
	voiceForModel,
	type SpeechModel,
} from '../src/lib/speech/speech'
import { appSettings } from '../src/lib/settings/settings.schema'

test.describe('speech/toSpeakableText — markdown becomes prose', () => {
	test('code blocks are announced once, not read', () => {
		const spoken = toSpeakableText(
			['Here is the fix:', '', '```ts', 'const secret = 1', '```', '```bash', 'echo hi', '```', '', 'Run it.'].join('\n'),
		)
		expect(spoken).not.toContain('const secret')
		expect(spoken).not.toContain('echo hi')
		expect(spoken).not.toContain('`')
		// Two adjacent blocks are one mention.
		expect(spoken.match(/Code block omitted\./g)).toHaveLength(1)
		expect(spoken).toBe('Here is the fix:\n\nCode block omitted.\n\nRun it.')
	})

	test('an unterminated fence — a reply cut off mid-block — still hides the code', () => {
		expect(toSpeakableText('Start.\n~~~python\nprint("x")\nmore')).toBe('Start.\n\nCode block omitted.')
	})

	test('links read as their text and bare URLs as their site', () => {
		const spoken = toSpeakableText(
			'See [the docs](https://example.com/a_(b)) or https://www.github.com/org/repo/pull/12. ![chart](http://x/y.png)',
		)
		expect(spoken).toBe('See the docs or github.com. chart')
	})

	test('headings, list items and table rows become sentences; separators vanish', () => {
		const spoken = toSpeakableText(
			['## Summary', '- first item', '- second item!', '1. third', '- [ ] a todo', '', '| Name | Value |', '| --- | :-: |', '| a | 1 |', '', '---'].join('\n'),
		)
		expect(spoken).toBe('Summary.\n\nfirst item. second item! third. a todo.\n\nName, Value. a, 1.')
	})

	test('emphasis marks go, but snake_case and arithmetic survive', () => {
		expect(toSpeakableText('Call **really** _carefully_ with `parse_config` and ~~not~~ 2 * 3 * 4 in file_name_here.')).toBe(
			'Call really carefully with parse_config and not 2 * 3 * 4 in file_name_here.',
		)
	})

	test('HTML tags and entities are cleaned, blockquote markers dropped', () => {
		expect(toSpeakableText('> Quoted &amp; <b>bold</b> a &lt; b')).toBe('Quoted & bold a < b')
	})

	test('empty or code-only replies', () => {
		expect(toSpeakableText('')).toBe('')
		expect(toSpeakableText('   \n\n  ')).toBe('')
		expect(toSpeakableText('```\nonly code\n```')).toBe('Code block omitted.')
	})
})

test.describe('speech/splitForSpeech — chunks under the cap', () => {
	test('short text is one chunk; empty text is none', () => {
		expect(splitForSpeech('Hello there.')).toEqual(['Hello there.'])
		expect(splitForSpeech('')).toEqual([])
		expect(splitForSpeech('\n\n  \n')).toEqual([])
	})

	test('defaults: a short first chunk, then chunks up to SPEECH_CHUNK_CHARACTERS', () => {
		const text = Array.from({ length: 200 }, (_, i) => `Sentence ${i} says something of moderate length.`).join(' ')
		const chunks = splitForSpeech(text)
		expect(chunks.length).toBeGreaterThan(2)
		expect(chunks[0].length).toBeLessThanOrEqual(SPEECH_FIRST_CHUNK_CHARACTERS)
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(SPEECH_CHUNK_CHARACTERS)
		// Cuts fall between sentences.
		for (const chunk of chunks) expect(chunk).toMatch(/\.$/)
	})

	test('no chunk ever exceeds the endpoint cap, whatever is asked for', () => {
		const text = 'word '.repeat(5000)
		const chunks = splitForSpeech(text, { maxChars: 50_000, firstChunkMaxChars: 50_000 })
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TTS_MAX_CHARACTERS)
	})

	test('a sentence longer than the limit is cut at spaces, and one giant word mid-word', () => {
		expect(splitForSpeech('a b c d e f', { maxChars: 3, firstChunkMaxChars: 3 })).toEqual(['a b', 'c d', 'e f'])
		expect(splitForSpeech('x'.repeat(25), { maxChars: 10, firstChunkMaxChars: 10 })).toEqual([
			'x'.repeat(10),
			'x'.repeat(10),
			'x'.repeat(5),
		])
	})

	test('every word arrives once and in order', () => {
		let seed = 7
		const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
		for (let round = 0; round < 50; round += 1) {
			const words: string[] = []
			const count = Math.floor(random() * 2500)
			for (let i = 0; i < count; i += 1) {
				let word = random() < 0.01 ? 'L'.repeat(Math.floor(random() * 700)) : `w${i}`
				if (random() < 0.1) word += '.'
				if (random() < 0.02) word += '\n\n'
				words.push(word)
			}
			const text = words.join(' ')
			const maxChars = 40 + Math.floor(random() * 3000)
			const firstChunkMaxChars = 10 + Math.floor(random() * 800)
			const chunks = splitForSpeech(text, { maxChars, firstChunkMaxChars })
			const squash = (s: string) => s.replace(/\s+/g, '')
			expect(squash(chunks.join(' '))).toBe(squash(text))
			for (const chunk of chunks) {
				expect(chunk.trim()).not.toBe('')
				expect(chunk.length).toBeLessThanOrEqual(Math.min(maxChars, TTS_MAX_CHARACTERS))
			}
			if (chunks[0]) expect(chunks[0].length).toBeLessThanOrEqual(Math.min(firstChunkMaxChars, maxChars))
		}
	})
})

test.describe('speech/repliesToSpeak — what auto-read reads when a turn ends', () => {
	/** A conversation `c1` that held one reply, `a1`, when the turn started. */
	const before = [
		{ id: 'u1', role: 'user', conversationId: 'c1', content: 'hi' },
		{ id: 'a1', role: 'assistant', conversationId: 'c1', content: 'old reply' },
	]
	const turn = startTurn('c1', before)

	test('the turn remembers its conversation and the replies already in it', () => {
		expect(turn.conversationId).toBe('c1')
		expect([...turn.known]).toEqual(['a1'])
		// A brand-new conversation starts with nothing known, so its first reply is read.
		expect(startTurn('c9', []).known.size).toBe(0)
	})

	test('only replies that are new since the turn began', () => {
		const messages = [
			...before,
			{ id: 'u2', role: 'user', conversationId: 'c1', content: 'again' },
			{ id: 'a2', role: 'assistant', conversationId: 'c1', content: 'new reply' },
		]
		expect(repliesToSpeak(turn, messages).map((m) => m.id)).toEqual(['a2'])
	})

	test('a turn that ends after the page moved to another conversation reads none of it', () => {
		// The chat page is reused: the turn started in c1, the user opened c2, then the turn
		// ended and the page reloaded — c2's whole history is "unknown" to the turn, not new.
		const other = [
			{ id: 'b1', role: 'assistant', conversationId: 'c2', content: 'an old answer in c2' },
			{ id: 'b2', role: 'assistant', conversationId: 'c2', content: 'another' },
		]
		expect(repliesToSpeak(turn, other)).toEqual([])
	})

	test('a reply saved as partial — Stop, or a failure — is not read', () => {
		const messages = [
			{ id: 'a2', role: 'assistant', conversationId: 'c1', content: 'half an ans', metadata: { partial: true, stoppedByUser: true } },
		]
		expect(repliesToSpeak(turn, messages)).toEqual([])
	})

	test('empty replies (tool-only turns) and optimistic drafts are skipped', () => {
		const messages = [
			{ id: 'a2', role: 'assistant', conversationId: 'c1', content: '   ' },
			{ id: 'a3', role: 'assistant', conversationId: 'c1', content: 'draft', optimistic: true },
			{ id: 'a4', role: 'assistant', conversationId: 'c1', content: null },
		]
		expect(repliesToSpeak(turn, messages)).toEqual([])
	})
})

test.describe('speech/catalogue and settings defaults', () => {
	test("OpenRouter's speech catalogue is reduced to id, name, per-character price and voices", () => {
		const models = parseSpeechCatalog({
			data: [
				{ id: 'z/paid', name: 'Zed', pricing: { prompt: '0.000015' }, supported_voices: ['a', 'b'] },
				{ id: 'a/free:free', name: 'Alpha', pricing: { prompt: '0' } },
				{ id: 'no-slash', name: 'bad id' },
				{ id: 'b/unpriced', pricing: { prompt: 'n/a' }, supported_voices: [1, 'ok'] },
				null,
			],
		})
		expect(models).toEqual([
			{ id: 'a/free:free', name: 'Alpha', pricePerCharacter: 0, voices: [] },
			{ id: 'b/unpriced', name: 'b/unpriced', pricePerCharacter: null, voices: ['ok'] },
			{ id: 'z/paid', name: 'Zed', pricePerCharacter: 0.000015, voices: ['a', 'b'] },
		])
		expect(parseSpeechCatalog({ nope: true })).toEqual([])
		expect(parseSpeechCatalog(null)).toEqual([])
	})

	test('the column defaults match the constants the server falls back to', () => {
		expect(appSettings.ttsModel.default).toBe(DEFAULT_TTS_MODEL)
		expect(appSettings.ttsVoice.default).toBe(DEFAULT_TTS_VOICE)
		// The old default does not exist on OpenRouter; every request with it failed.
		expect(DEFAULT_TTS_MODEL).not.toBe('openai/gpt-4o-mini-tts')
		expect(SPEECH_MODEL_ID_PATTERN.test(DEFAULT_TTS_MODEL)).toBe(true)
		expect(SPEECH_VOICE_PATTERN.test(DEFAULT_TTS_VOICE)).toBe(true)
	})

	test('picking a model keeps a voice it offers, else its first; a model with no voice list gets its default', () => {
		const kokoro: SpeechModel = { id: 'hexgrad/kokoro-82m', name: 'Kokoro', pricePerCharacter: 0.000004, voices: ['af_heart', 'am_adam'] }
		// fish-audio/s1 and friends: the catalogue lists no voices, so the field is free text.
		const fish: SpeechModel = { id: 'fish-audio/s1', name: 'Fish Audio S1', pricePerCharacter: 0.000015, voices: [] }

		expect(voiceForModel(kokoro, 'am_adam')).toBe('am_adam')
		expect(voiceForModel(kokoro, 'alloy')).toBe('af_heart')
		expect(voiceForModel(kokoro, '')).toBe('af_heart')
		// Kokoro's af_heart would be refused as an unknown voice: fall back to the model's own.
		expect(voiceForModel(fish, 'af_heart')).toBe('')
		expect(voiceForModel(fish, '')).toBe('')
		// Not in the catalogue (it could not be read, or the id was typed): leave the voice alone.
		expect(voiceForModel(undefined, 'af_heart')).toBe('af_heart')
		expect(voiceForModel(null, '')).toBe('')
	})

	test('model and voice patterns accept real catalogue names and refuse junk', () => {
		for (const id of ['hexgrad/kokoro-82m', 'deepgram/flux-tts:free', 'qwen/qwen-audio-3.0-tts-flash']) {
			expect(SPEECH_MODEL_ID_PATTERN.test(id), id).toBe(true)
		}
		for (const id of ['', 'kokoro', 'a/b c', 'a/b\nc', '../etc/passwd']) {
			expect(SPEECH_MODEL_ID_PATTERN.test(id), id).toBe(false)
		}
		for (const voice of ['', 'af_heart', 'aura-2-thalia-en', 'en-US-Harper:MAI-Voice-2', 'longanhuan_v3.6']) {
			expect(SPEECH_VOICE_PATTERN.test(voice), voice).toBe(true)
		}
		for (const voice of ['a\nb', '<script>', 'x'.repeat(81)]) {
			expect(SPEECH_VOICE_PATTERN.test(voice), voice).toBe(false)
		}
	})
})
