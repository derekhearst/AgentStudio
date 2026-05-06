import type { RequestHandler } from '@sveltejs/kit'
import { listActiveChatRunsForUser } from '$lib/runs'
import { encodeSseData } from '$lib/runtime/sse-codec'

export const GET: RequestHandler = ({ request, locals }) => {
	if (!locals.user) {
		return new Response('Unauthorized', { status: 401 })
	}

	const userId = locals.user.id
	let intervalId: ReturnType<typeof setInterval> | undefined

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			const emitSnapshot = async () => {
				const runs = await listActiveChatRunsForUser(userId)
				try {
					controller.enqueue(encodeSseData(runs))
				} catch {
					if (intervalId) clearInterval(intervalId)
				}
			}

			void emitSnapshot()
			intervalId = setInterval(() => {
				void emitSnapshot()
			}, 700)

			request.signal.addEventListener('abort', () => {
				if (intervalId) clearInterval(intervalId)
				try {
					controller.close()
				} catch {
					// Already closed.
				}
			})
		},
		cancel() {
			if (intervalId) clearInterval(intervalId)
		},
	})

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}
