/**
 * Read-aloud (#27) — the pure half, shared by the browser and the server.
 *
 * A reply is markdown written to be read on screen. Spoken as-is it would recite fences,
 * table pipes and every character of a URL, so `toSpeakableText` turns it into prose first.
 * `splitForSpeech` then cuts that prose into pieces the synthesis endpoint accepts, on
 * sentence boundaries so the joins are not audible, with a short first piece so playback
 * starts quickly. `startTurn` / `noteStop` / `repliesToSpeak` pick which replies a finished
 * turn produced, for auto-read, and `voiceForModel` which voice carries over when
 * Settings changes model.
 *
 * No `$lib` imports and no DOM: specs import this directly in the plain Playwright loader.
 */

/** The most characters one `/api/tts` request may carry. Longer replies are chunked. */
export const TTS_MAX_CHARACTERS = 8000

/**
 * Defaults for a new settings row. Kokoro is among the cheapest paid speech models in
 * OpenRouter's catalogue (about $4 per million characters; only a preview model undercuts
 * it) and lists dozens of English voices; `af_heart` is the one its authors rate best.
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

/**
 * The voice to keep when the user picks `model` in Settings. Voices are per model: one the
 * new model offers is kept, otherwise its first voice is chosen. A model whose voices the
 * catalogue does not list gets the empty voice — its own default — because a voice carried
 * over from another model would almost certainly be refused. A model missing from the
 * catalogue leaves the voice alone.
 */
export function voiceForModel(model: SpeechModel | null | undefined, voice: string): string {
	if (!model) return voice
	if (model.voices.length === 0) return ''
	return model.voices.includes(voice) ? voice : model.voices[0]
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
	conversationId: string
	content?: string | null
	optimistic?: boolean
	metadata?: unknown
}

/** What the stream route saves as a reply when the turn wrote no text. */
const NO_OUTPUT_REPLY = '(no output)'

/**
 * Whether a saved reply has anything to read. Not when it is blank, and not when it is the
 * stream route's `(no output)` placeholder — alone, or after the attachment warning the route
 * puts in front of it — which would be read out as the words "no output" and billed.
 */
export function hasReplyText(content: string | null | undefined): boolean {
	const text = (content ?? '').trim()
	if (!text) return false
	if (!text.endsWith(NO_OUTPUT_REPLY)) return true
	const before = text.slice(0, -NO_OUTPUT_REPLY.length)
	if (!before) return false
	// The attachment warning is a blockquote followed by a blank line. Anything else in front
	// is the model's own text that happens to end in those words.
	return !(before.endsWith('\n\n') && before.trim().split('\n').every((line) => line.startsWith('>')))
}

/**
 * A turn as auto-read follows it: its conversation, the replies already in it when it began,
 * the error the page was showing as it began, and whether the user pressed Stop on it.
 */
export type TurnStart = {
	conversationId: string
	known: ReadonlySet<string>
	/**
	 * A turn that follows a run started elsewhere begins with the refusal that sent it there
	 * still on screen. That is not this turn failing.
	 */
	errorAtStart: string | null
	stopped: boolean
}

export function startTurn(conversationId: string, messages: readonly SpeakableMessage[], error: string | null = null): TurnStart {
	return {
		conversationId,
		known: new Set(messages.filter((m) => m.role === 'assistant').map((m) => m.id)),
		errorAtStart: error,
		stopped: false,
	}
}

/**
 * Note that the user pressed Stop on the turn. It has to be noted while the turn runs: the
 * chat page clears its Stop flag in the same step that ends the turn.
 */
export function noteStop(turn: TurnStart): TurnStart {
	return turn.stopped ? turn : { ...turn, stopped: true }
}

/**
 * Which replies a finished turn produced, for auto-read. `errorAtEnd` is the error the page
 * shows as the turn ends: a failed turn leaves its error up, and a turn that finishes clears
 * whatever a hiccup on the way (a tool approval that had to be retried) put there.
 *
 * None when the user pressed Stop, or when the turn failed. The saved reply alone cannot say
 * so: after a failure the stream route still saves what the run wrote, as an ordinary reply,
 * and after Stop the run's own save can land — replacing the page's partial copy — before
 * the page reloads. Reading half an answer aloud after the user pressed Stop is the opposite
 * of what they asked for.
 *
 * Otherwise, only replies in the turn's own conversation that were not already there when it
 * started. The chat page is reused from one conversation to the next, so a turn can end after
 * the page has moved on — the other conversation's history is not new, and must not be read.
 * A reply saved as `partial`, or with no text to read (see `hasReplyText`), is skipped too.
 */
export function repliesToSpeak<T extends SpeakableMessage>(
	turn: TurnStart,
	messages: readonly T[],
	errorAtEnd: string | null = null,
): T[] {
	if (turn.stopped) return []
	if (errorAtEnd !== null && errorAtEnd !== turn.errorAtStart) return []
	return messages.filter((message) => {
		if (message.role !== 'assistant' || message.optimistic) return false
		if (message.conversationId !== turn.conversationId || turn.known.has(message.id)) return false
		const metadata = message.metadata && typeof message.metadata === 'object' ? (message.metadata as Record<string, unknown>) : null
		if (metadata?.partial === true) return false
		return hasReplyText(message.content)
	})
}
