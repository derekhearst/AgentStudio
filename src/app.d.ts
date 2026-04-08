// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			authenticated: boolean
			user: {
				id: string
				name: string
				username: string
				role: 'admin' | 'user'
			} | null
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	// Web Speech API (Chrome/Edge/Safari)
	interface SpeechRecognitionEvent extends Event {
		readonly resultIndex: number
		readonly results: SpeechRecognitionResultList
	}

	interface SpeechRecognitionResultList {
		readonly length: number
		item(index: number): SpeechRecognitionResult
		[index: number]: SpeechRecognitionResult
	}

	interface SpeechRecognitionResult {
		readonly isFinal: boolean
		readonly length: number
		item(index: number): SpeechRecognitionAlternative
		[index: number]: SpeechRecognitionAlternative
	}

	interface SpeechRecognitionAlternative {
		readonly confidence: number
		readonly transcript: string
	}

	interface SpeechRecognition extends EventTarget {
		continuous: boolean
		interimResults: boolean
		lang: string
		start(): void
		stop(): void
		abort(): void
		onresult: ((event: SpeechRecognitionEvent) => void) | null
		onend: (() => void) | null
		onerror: ((event: Event & { error: string }) => void) | null
		onaudiostart: (() => void) | null
		onaudioend: (() => void) | null
	}

	interface SpeechRecognitionConstructor {
		new (): SpeechRecognition
	}

	interface Window {
		__TAURI_INTERNALS__?: unknown
		__TAURI__?: {
			core: {
				invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>
			}
		}
		SpeechRecognition?: SpeechRecognitionConstructor
		webkitSpeechRecognition?: SpeechRecognitionConstructor
	}
}

export {}
