/**
 * SSE wire-format helpers shared across runtime sessions and route handlers.
 *
 * Two frame shapes exist in the codebase:
 *   - Named events with optional sequence id (the chat run stream protocol).
 *   - Anonymous `data:`-only frames (the simpler monitor endpoints that just push snapshots).
 */

const sseEncoder = new TextEncoder()

export function encodeSseFrame(name: string, payload: unknown, seq?: number): Uint8Array {
	const idLine = seq === undefined ? '' : `id: ${seq}\n`
	return sseEncoder.encode(`${idLine}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
}

export function encodeSseData(payload: unknown): Uint8Array {
	return sseEncoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}
