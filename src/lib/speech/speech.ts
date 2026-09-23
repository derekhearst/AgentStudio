/**
 * Read-aloud (#27) — the pure half, shared by the browser and the server.
 *
 * A reply is markdown written to be read on screen. Spoken as-is it would recite fences,
 * table pipes and every character of a URL, so `toSpeakableText` turns it into prose first.
 * `splitForSpeech` then cuts that prose into pieces the synthesis endpoint accepts, on
 * sentence boundaries so the joins are not audible, with a short first piece so playback
 * starts quickly. `repliesToSpeak` picks which replies a finished turn produced, for
 * auto-read.
 *
 * No `$lib` imports and no DOM: specs import this directly in the plain Playwright loader.
 */

/** The most characters one `/api/tts` request may carry. Longer replies are chunked. */
export const TTS_MAX_CHARACTERS = 8000

/**
 * Defaults for a new settings row. Kokoro is the cheapest paid speech model in OpenRouter's
 * catalogue and lists dozens of English voices; `af_heart` is the one its authors rate best.
 * The previous hard-coded `openai/gpt-4o-mini-tts` is not in the catalogue — OpenRouter
 * answers "Model openai/gpt-4o-mini-tts does not exist" — so every request failed.
 */
export const DEFAULT_TTS_MODEL = 'hexgrad/kokoro-82m'
export const DEFAULT_TTS_VOICE = 'af_heart'

/**
 * Chunk sizes for playback. The first piece is short because nothing plays until it has been
 * synthesised; later pieces are fetched while the previous one plays, so they can be longer.
 * Both stay well under `TTS_MAX_CHARACTERS` — several catalogue models have a 4K-token
 * context, and a smaller piece also bounds what a Stop part-way through has already paid for.
 */
export const SPEECH_FIRST_CHUNK_CHARACTERS = 400
export const SPEECH_CHUNK_CHARACTERS = 2000

/** An OpenRouter model id, e.g. `hexgrad/kokoro-82m` or `deepgram/flux-tts:free`. */
export const SPEECH_MODEL_ID_PATTERN = /^[\w.-]+\/[\w.:-]+$/
/** A provider voice name, e.g. `af_heart`, `aura-2-thalia-en`, `en-US-Harper:MAI-Voice-2`. Empty = the model's default. */
export const SPEECH_VOICE_PATTERN = /^[\w.:\- ]{0,80}$/

/** What a read-aloud request was for, recorded on its ledger row. */
export type SpeechPurpose = 'message' | 'autoplay' | 'preview'

/** One entry of OpenRouter's speech-model catalogue, reduced to what the app uses. */
export type SpeechModel = {
	id: string
	name: string
	/** USD per input character, or null when the catalogue gives no usable price. */
	pricePerCharacter: number | null
	/** Voice names the model accepts. Empty when the catalogue does not list them. */
	voices: string[]
}

const CODE_BLOCK_SPOKEN = 'Code block omitted.'

/**
 * Reduce OpenRouter's `/models?output_modalities=speech` answer to `SpeechModel`s.
 * Tolerant of missing fields: a malformed entry is skipped rather than failing the list.
 */
export function parseSpeechCatalog(body: unknown): SpeechModel[] {
	const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
	if (!Array.isArray(data)) return []
	const models: SpeechModel[] = []
	for (const entry of data) {
		if (!entry || typeof entry !== 'object') continue
		const raw = entry as {
			id?: unknown
			name?: unknown
			pricing?: { prompt?: unknown }
			supported_voices?: unknown
		}
		if (typeof raw.id !== 'string' || !SPEECH_MODEL_ID_PATTERN.test(raw.id)) continue
		const price = Number.parseFloat(typeof raw.pricing?.prompt === 'string' ? raw.pricing.prompt : '')
		models.push({
			id: raw.id,
			name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id,
			pricePerCharacter: Number.isFinite(price) && price >= 0 ? price : null,
			voices: Array.isArray(raw.supported_voices)
				? raw.supported_voices.filter((v): v is string => typeof v === 'string' && v.length > 0)
				: [],
		})
	}
	return models.sort((a, b) => a.name.localeCompare(b.name))
}

/** Append a full stop when a line has no closing punctuation, so the voice pauses after it. */
function endSentence(line: string): string {
	const trimmed = line.trim()
	if (!trimmed) return ''
	return /[.!?:;…]["'”’)\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return 'link'
	}
}

/** Inline markdown → the words it displays. */
function speakInline(line: string): string {
	return (
		line
			// Images read as their alt text; links as their text.
			.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
			.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
			.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
			// Footnote markers say nothing useful aloud.
			.replace(/\[\^[^\]]+\]/g, '')
			// Autolinks and bare URLs: the site, not every character of the address.
			.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => hostnameOf(url))
			.replace(/https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g, (url) => hostnameOf(url))
			// Inline code keeps its text: it is usually a name worth hearing.
			.replace(/(`+)([^`]+?)\1/g, '$2')
			// HTML tags, but not a comparison like `a < b`.
			.replace(/<\/?[a-zA-Z][^>]*>/g, '')
			// Emphasis and strikethrough. Underscores only at word edges, so snake_case survives.
			.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
			.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1$2')
			.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1$2')
			.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
			// Backslash escapes, then the few entities a reply realistically contains.
			.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
			.replace(/&nbsp;/g, ' ')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;|&apos;/g, "'")
			.replace(/&amp;/g, '&')
			.replace(/[ \t]+/g, ' ')
			.trim()
	)
}

/**
 * Markdown → prose a voice can read.
 *
 * Fenced code becomes one short sentence saying it was skipped; headings, list items and
 * table rows become sentences of their own; links read as their text and bare URLs as their
 * site. Paragraphs stay separated by a blank line, which `splitForSpeech` prefers to cut at.
 */
export function toSpeakableText(markdown: string): string {
	const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
	const paragraphs: string[] = []
	let current: string[] = []
	let fence: string | null = null

	const flush = () => {
		const text = current.join(' ').replace(/\s+/g, ' ').trim()
		if (text) paragraphs.push(text)
		current = []
	}
	/** A line that is a sentence on its own: heading, list item, table row. */
	const pushStandalone = (text: string) => {
		const sentence = endSentence(speakInline(text))
		if (sentence) current.push(sentence)
	}

	for (const line of lines) {
		if (fence) {
			const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line)
			if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
			continue
		}
		const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
		if (open) {
			fence = open[1]
			flush()
			// One mention for a run of adjacent blocks, not one per block.
			if (paragraphs.at(-1) !== CODE_BLOCK_SPOKEN) paragraphs.push(CODE_BLOCK_SPOKEN)
			continue
		}

		const trimmed = line.trim()
		if (!trimmed) {
			flush()
			continue
		}
		// Horizontal rules and table separator rows.
		if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
			flush()
			continue
		}
		if (trimmed.includes('|') && trimmed.includes('-') && /^[|:\s-]+$/.test(trimmed)) continue
		// Link reference definitions: `[1]: https://…`.
		if (/^\[[^\]]+\]:\s+\S+/.test(trimmed)) continue

		const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(trimmed)
		if (heading) {
			flush()
			pushStandalone(heading[1])
			flush()
			continue
		}

		let body = trimmed.replace(/^(>\s?)+/, '')
		if (body.startsWith('|') || (body.includes(' | ') && body.endsWith('|'))) {
			const cells = body
				.split('|')
				.map((cell) => speakInline(cell))
				.filter(Boolean)
			if (cells.length > 0) current.push(endSentence(cells.join(', ')))
			continue
		}

		const listItem = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(body)
		if (listItem) {
			pushStandalone(listItem[1])
			continue
		}

		body = speakInline(body)
		if (body) current.push(body)
	}
	flush()
	return paragraphs.join('\n\n')
}

/** Cut one over-long sentence at spaces, or mid-word when a single word is too long. */
function splitLongSentence(sentence: string, limit: number): string[] {
	const pieces: string[] = []
	let rest = sentence
	while (rest.length > limit) {
		const cut = rest.lastIndexOf(' ', limit)
		const at = cut > 0 ? cut : limit
		pieces.push(rest.slice(0, at).trim())
		rest = rest.slice(at).trim()
	}
	if (rest) pieces.push(rest)
	return pieces
}

/**
 * Split speakable text into chunks for sequential synthesis.
 *
 * Cuts fall between sentences where possible, and between paragraphs by preference. No chunk
 * exceeds `maxChars` (never more than `TTS_MAX_CHARACTERS`), and the first chunk does not
 * exceed `firstChunkMaxChars` either. Empty input gives no chunks.
 */
export function splitForSpeech(
	text: string,
	options: { maxChars?: number; firstChunkMaxChars?: number } = {},
): string[] {
	const maxChars = Math.max(1, Math.min(TTS_MAX_CHARACTERS, Math.floor(options.maxChars ?? SPEECH_CHUNK_CHARACTERS)))
	const firstMax = Math.max(
		1,
		Math.min(maxChars, Math.floor(options.firstChunkMaxChars ?? SPEECH_FIRST_CHUNK_CHARACTERS)),
	)

	const chunks: string[] = []
	let current = ''
	const limit = () => (chunks.length === 0 ? firstMax : maxChars)
	const push = () => {
		if (current.trim()) chunks.push(current.trim())
		current = ''
	}

	const paragraphs = (text ?? '').split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
	for (const paragraph of paragraphs) {
		const sentences = paragraph.split(/(?<=[.!?…]["'”’)\]]*)\s+/).filter(Boolean)
		let separator = current ? '\n\n' : ''
		for (const sentence of sentences) {
			if (current && current.length + separator.length + sentence.length <= limit()) {
				current += separator + sentence
			} else if (!current && sentence.length <= limit()) {
				current = sentence
			} else {
				push()
				const pieces = splitLongSentence(sentence, limit())
				for (const [i, piece] of pieces.entries()) {
					if (i > 0) push()
					// A piece cut for the first chunk's limit may exceed it for later ones — never
					// the other way round, since later limits are at least as large.
					current = piece
				}
			}
			separator = ' '
		}
	}
	push()
	return chunks
}

type SpeakableMessage = {
	id: string
	role: string
	content?: string | null
	optimistic?: boolean
	metadata?: unknown
}

/**
 * Which replies a finished turn produced, for auto-read.
 *
 * `known` holds the assistant message ids that existed when the turn started. A reply saved
 * as `partial` is a turn that was stopped or failed part-way: reading half an answer aloud
 * after the user pressed Stop is the opposite of what they asked for.
 */
export function repliesToSpeak<T extends SpeakableMessage>(known: ReadonlySet<string>, messages: readonly T[]): T[] {
	return messages.filter((message) => {
		if (message.role !== 'assistant' || known.has(message.id) || message.optimistic) return false
		const metadata = message.metadata && typeof message.metadata === 'object' ? (message.metadata as Record<string, unknown>) : null
		if (metadata?.partial === true) return false
		return Boolean(message.content?.trim())
	})
}
