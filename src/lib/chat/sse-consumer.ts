/**
 * SSE chunk → event async iterator extracted from the chat page's stream loop.
 *
 * Wraps the read/decode/parse/resume cycle so the caller's `for await` body only
 * cares about the application semantics of each `{ event, payload }` it receives.
 *
 * The caller owns:
 *   - The initial fetch (so it can mark a successful handshake before iterating).
 *   - The abort signal and `shouldStop` predicate (which drives both the resume
 *     gate and the per-event break — buffered events keep arriving after Stop).
 *   - All logging callbacks (the page uses a structured logger that this module
 *     doesn't import).
 *
 * Resume protocol: when the underlying reader throws or returns done before the
 * caller's `shouldStop()` returns true, we call `fetchResume(lastSeenSeq)` up to
 * `maxResumeAttempts` times. The remote responds with events whose `id:` is
 * strictly greater than `since`, so we can pick up from where the prior reader
 * stopped.
 */

export type SseEvent = {
	/** The `id:` field, or null when the event didn't carry one. */
	id: number | null
	/** The `event:` field. */
	event: string
	/** The parsed JSON `data:` field. */
	payload: Record<string, unknown>
}

export type SseConsumerOptions = {
	/** Already-fetched initial response. The caller drives the handshake. */
	initialResponse: Response
	/** Retry endpoint — pass the last-seen seq, get a fresh response with subsequent events. */
	fetchResume: (lastSeenSeq: number) => Promise<Response>
	/**
	 * Should the loop terminate? Checked after a `done` chunk and before each event
	 * is yielded. `doneReceived || stoppedByUser` in the chat page.
	 */
	shouldStop: () => boolean
	/** Default 3. */
	maxResumeAttempts?: number

	// Telemetry callbacks — fire-and-forget so the consumer doesn't have to know
	// about the host's logger.
	onResumeAttempt?: (info: { lastSeenSeq: number; attempt: number }) => void
	onResumeRejected?: (info: { status: number }) => void
	onResumeError?: (err: unknown) => void
	onParseError?: (info: { eventName: string; rawData: string; error: unknown }) => void
}

type ChunkReader = ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>

export async function* consumeSseStream(opts: SseConsumerOptions): AsyncGenerator<SseEvent> {
	if (!opts.initialResponse.ok || !opts.initialResponse.body) {
		const text = await opts.initialResponse.text().catch(() => '')
		throw new Error(
			`Failed to open stream (status ${opts.initialResponse.status})${text ? `: ${text}` : ''}`,
		)
	}
	let reader: ChunkReader = opts.initialResponse.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let lastSeenSeq = 0
	let resumeAttempts = 0
	const maxResumeAttempts = opts.maxResumeAttempts ?? 3

	const tryResume = async (): Promise<ChunkReader | null> => {
		if (opts.shouldStop() || resumeAttempts >= maxResumeAttempts) return null
		resumeAttempts += 1
		opts.onResumeAttempt?.({ lastSeenSeq, attempt: resumeAttempts })
		try {
			const resp = await opts.fetchResume(lastSeenSeq)
			if (!resp.ok || !resp.body) {
				opts.onResumeRejected?.({ status: resp.status })
				return null
			}
			return resp.body.getReader()
		} catch (err) {
			opts.onResumeError?.(err)
			return null
		}
	}

	while (true) {
		let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>
		try {
			chunk = await reader.read()
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') throw err
			const next = await tryResume()
			if (!next) throw err
			reader = next
			buffer = ''
			continue
		}
		if (chunk.done) {
			if (opts.shouldStop()) return
			const next = await tryResume()
			if (!next) return
			reader = next
			buffer = ''
			continue
		}
		buffer += decoder.decode(chunk.value, { stream: true })
		const rawEvents = buffer.split('\n\n')
		buffer = rawEvents.pop() ?? ''

		for (const raw of rawEvents) {
			// Caller can clear shouldStop() at any time — buffered events arrive AFTER
			// abort, so we re-check between each yield and bail quietly when set.
			if (opts.shouldStop()) return
			const parsed = parseSseEvent(raw, lastSeenSeq, opts.onParseError)
			if (!parsed) continue
			if (parsed.id !== null) lastSeenSeq = parsed.id
			yield parsed
		}
	}
}

/**
 * Parse a single `\n\n`-separated event block. Tolerates missing `id:` (returns id=null),
 * skips blocks without an `event:` or `data:`, and reports JSON parse failures via
 * `onParseError` rather than throwing.
 */
function parseSseEvent(
	raw: string,
	prevSeq: number,
	onParseError?: (info: { eventName: string; rawData: string; error: unknown }) => void,
): SseEvent | null {
	const lines = raw.split('\n')
	let id: number | null = null
	let event: string | null = null
	let data: string | null = null
	for (const line of lines) {
		if (line.startsWith('id: ')) {
			const parsed = Number.parseInt(line.slice(4).trim(), 10)
			if (Number.isFinite(parsed) && parsed > prevSeq) id = parsed
		} else if (line.startsWith('event: ')) {
			event = line.slice(7).trim()
		} else if (line.startsWith('data: ')) {
			data = line.slice(6)
		}
	}
	if (!event || data === null) return null
	try {
		const payload = JSON.parse(data) as Record<string, unknown>
		return { id, event, payload }
	} catch (err) {
		onParseError?.({ eventName: event, rawData: data.slice(0, 300), error: err })
		return null
	}
}
