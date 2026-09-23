/**
 * Read-aloud playback (#27) — one player for the whole page.
 *
 * A reply is turned into speakable prose, cut into chunks under the endpoint's cap, and each
 * chunk is fetched from `/api/tts` and played in order on one shared <audio> element. The
 * next chunk is requested once the current one has started playing, so it is usually ready
 * by the time the current one ends — and a browser that refuses to play at all has paid for
 * the short first chunk only. Starting another reply, Stop, or a failure aborts whatever is
 * still in flight and silences the element. The server skips a synthesis it has not started
 * yet; one OpenRouter is already working on is paid for, and recorded, either way.
 *
 * One element, reused, because of autoplay rules: a browser lets a page start audio only
 * after the user has interacted with it, and iOS Safari only on an element that was first
 * played from a tap. `play()` primes the element synchronously while it is still inside the
 * click; turning auto-read on, or the first tap or key press after a reload with it on (see
 * AutoRead), does the same, so a reply that finishes later can speak.
 */

import {
	SPEECH_CHUNK_CHARACTERS,
	SPEECH_FIRST_CHUNK_CHARACTERS,
	splitForSpeech,
	toSpeakableText,
	type SpeechPurpose,
} from './speech'

export type SpeechStatus = 'idle' | 'loading' | 'playing'

export type SpeechOptions = {
	/** Override the saved model/voice for this playback — Settings uses this to preview. */
	model?: string
	voice?: string
	purpose?: SpeechPurpose
}

/** 10ms of 8kHz silence: played from a tap so later, untapped playback is allowed. */
const SILENT_WAV =
	'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

async function requestSpeech(text: string, options: SpeechOptions, signal: AbortSignal): Promise<Blob> {
	const response = await fetch('/api/tts', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg, application/json' },
		body: JSON.stringify({ text, model: options.model, voice: options.voice, purpose: options.purpose }),
		signal,
	})
	if (!response.ok) {
		let message = `Read-aloud failed (HTTP ${response.status}).`
		try {
			const body = (await response.json()) as { message?: unknown }
			if (typeof body?.message === 'string' && body.message.trim()) message = body.message
		} catch {
			// not JSON (a proxy's error page) — keep the status-only message
		}
		throw new Error(message)
	}
	return response.blob()
}

function playbackError(err: unknown): Error {
	if (err instanceof DOMException && err.name === 'NotAllowedError') {
		return new Error('The browser blocked playback. Press play on the reply to hear it.')
	}
	return new Error('This browser could not play the audio.')
}

class SpeechPlayer {
	/** What is being read: a message id, or another caller's key such as a settings preview. */
	activeId = $state<string | null>(null)
	status = $state<SpeechStatus>('idle')
	/** Why the current playback started: turning auto-read off stops only what it started. */
	activePurpose = $state<SpeechPurpose | null>(null)
	/** The last failure and whose it was, until that item is played again. */
	error = $state<{ id: string; message: string } | null>(null)

	#audio: HTMLAudioElement | null = null
	#controller: AbortController | null = null
	#primed = false

	statusOf(id: string): SpeechStatus {
		return this.activeId === id ? this.status : 'idle'
	}

	errorOf(id: string): string | null {
		return this.error?.id === id ? this.error.message : null
	}

	/** Play `id`, or stop it if it is the one playing. Call from the click handler itself. */
	toggle(id: string, markdown: string, options: SpeechOptions = {}): void {
		if (this.activeId === id) this.stop()
		else void this.play(id, markdown, options)
	}

	/**
	 * Allow later playback without a tap. Call from a user gesture; harmless anywhere else.
	 * Resolves true once the element is primed, false when this attempt did not prime it.
	 */
	unlock(): Promise<boolean> {
		if (this.#primed) return Promise.resolve(true)
		if (this.activeId) return Promise.resolve(false)
		const audio = this.#element()
		if (!audio) return Promise.resolve(false)
		audio.src = SILENT_WAV
		return audio.play().then(
			() => (this.#primed = true),
			() => false,
		)
	}

	stop(): void {
		this.#controller?.abort()
		this.#controller = null
		this.#audio?.pause()
		this.activeId = null
		this.activePurpose = null
		this.status = 'idle'
	}

	async play(id: string, markdown: string, options: SpeechOptions = {}): Promise<void> {
		this.stop()
		const chunks = splitForSpeech(toSpeakableText(markdown), {
			maxChars: SPEECH_CHUNK_CHARACTERS,
			firstChunkMaxChars: SPEECH_FIRST_CHUNK_CHARACTERS,
		})
		if (chunks.length === 0) return
		// Still inside the click that called us, if there was one — see the module comment.
		void this.unlock()

		const controller = new AbortController()
		this.#controller = controller
		this.activeId = id
		this.activePurpose = options.purpose ?? 'message'
		this.status = 'loading'
		if (this.error?.id === id) this.error = null

		const fetchChunk = (index: number) => {
			const pending = requestSpeech(chunks[index], options, controller.signal)
			// Awaited later; this only stops an early failure being reported as unhandled.
			pending.catch(() => undefined)
			return pending
		}

		try {
			let next: Promise<Blob> | null = fetchChunk(0)
			for (let index = 0; next; index += 1) {
				const blob: Blob = await next
				if (controller.signal.aborted) return
				const following = index + 1 < chunks.length ? index + 1 : null
				let prefetched: Promise<Blob> | null = null
				this.status = 'playing'
				// The next chunk is asked for only once this one is audibly playing, never before.
				await this.#playBlob(blob, controller.signal, () => {
					if (following !== null) prefetched = fetchChunk(following)
				})
				if (controller.signal.aborted) return
				next = following === null ? null : (prefetched ?? fetchChunk(following))
			}
		} catch (err) {
			if (controller.signal.aborted) return
			this.error = { id, message: err instanceof Error ? err.message : String(err) }
		} finally {
			// Nothing this playback asked for is wanted any more. After a failure that includes a
			// chunk already requested for later: the server skips it if OpenRouter has not got it yet.
			controller.abort()
			// A newer play() owns the state and the element now; leave them alone.
			if (this.#controller === controller) {
				// Silent already after the last chunk; after a failure it may not be.
				this.#audio?.pause()
				this.#controller = null
				this.activeId = null
				this.activePurpose = null
				this.status = 'idle'
			}
		}
	}

	#element(): HTMLAudioElement | null {
		if (typeof Audio === 'undefined') return null
		this.#audio ??= new Audio()
		return this.#audio
	}

	/** Play one chunk to its end. `onStarted` runs once the browser has actually begun playing it. */
	#playBlob(blob: Blob, signal: AbortSignal, onStarted: () => void): Promise<void> {
		const audio = this.#element()
		if (!audio) return Promise.reject(new Error('This browser cannot play audio.'))
		const url = URL.createObjectURL(blob)
		return new Promise<void>((resolve, reject) => {
			let settled = false
			const cleanup = () => {
				settled = true
				audio.removeEventListener('ended', onEnded)
				audio.removeEventListener('error', onError)
				signal.removeEventListener('abort', onAbort)
				URL.revokeObjectURL(url)
			}
			const onEnded = () => {
				cleanup()
				resolve()
			}
			const onError = () => {
				cleanup()
				reject(new Error('This browser could not play the audio.'))
			}
			const onAbort = () => {
				audio.pause()
				cleanup()
				resolve()
			}
			audio.addEventListener('ended', onEnded)
			audio.addEventListener('error', onError)
			signal.addEventListener('abort', onAbort)
			audio.src = url
			audio.play().then(
				() => {
					if (!settled && !signal.aborted) onStarted()
				},
				(err: unknown) => {
					if (settled || signal.aborted) return
					cleanup()
					reject(playbackError(err))
				},
			)
		})
	}
}

export const speechPlayer = new SpeechPlayer()

const AUTO_READ_KEY = 'agentstudio:speech:auto-read'

/**
 * Auto-read on/off — per device, in localStorage, never on the account: hands-free on a
 * phone in the car should not make a desktop tab start talking too.
 */
class AutoReadPreference {
	#enabled = $state(false)

	constructor() {
		try {
			if (typeof localStorage !== 'undefined') this.#enabled = localStorage.getItem(AUTO_READ_KEY) === '1'
		} catch {
			// storage blocked (private mode, sandboxed frame) — default off
		}
	}

	get enabled(): boolean {
		return this.#enabled
	}

	set enabled(value: boolean) {
		this.#enabled = value
		try {
			localStorage.setItem(AUTO_READ_KEY, value ? '1' : '0')
		} catch {
			// not persisted; still applies for this page
		}
	}
}

export const autoRead = new AutoReadPreference()
