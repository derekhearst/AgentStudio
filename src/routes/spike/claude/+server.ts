/**
 * Spike endpoint: stream a Claude Agent SDK run as SSE.
 *
 * Deliberately self-contained — it does not import from $lib/runtime or
 * $lib/chat, because those are the layers this spike is evaluating replacing.
 */

import type { RequestHandler } from '@sveltejs/kit'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spikeOptions } from '$lib/spike/claude-agent.server'

function frame(event: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { prompt?: string }
	const prompt = body.prompt?.trim()

	if (!prompt) {
		return new Response(JSON.stringify({ error: 'prompt is required' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		})
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const startedAt = Date.now()
			try {
				for await (const message of query({ prompt, options: spikeOptions })) {
					// Forward the raw SDK message shape; the page decides what to show.
					controller.enqueue(frame(message))
				}
				controller.enqueue(frame({ type: 'spike_done', ms: Date.now() - startedAt }))
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				controller.enqueue(frame({ type: 'spike_error', error: message }))
			} finally {
				controller.close()
			}
		},
	})

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
		},
	})
}
