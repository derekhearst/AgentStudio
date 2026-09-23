import type { Page } from '@playwright/test'

/**
 * A scripted chat run for UI specs that need the page mid-turn but no model.
 *
 * `/chat/[id]/stream` and `/stream/resume` are intercepted in the browser. The stream's
 * response ends without `done`, which to the page's SSE consumer is exactly a dropped
 * connection, so the page reconnects through `stream/resume` — and the script holds that
 * request open, keeping the page in its running state until the spec calls `release()`,
 * which answers it with a terminal `done`.
 *
 * `/chat/[id]/stop` is intercepted too, and records what the page sent.
 */

export function sse(frames: Array<{ id?: number; event: string; data: unknown }>) {
	return frames
		.map((f) => `${f.id !== undefined ? `id: ${f.id}\n` : ''}event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
		.join('')
}

/** The background task the scripted run reports. */
export const SCRIPTED_TASK = { id: 'bash_1', type: 'local_bash', description: 'npm run dev' }

export async function scriptDroppedRun(page: Page, conversationId: string, runId: string) {
	let release: () => void = () => {}
	const resumeGate = new Promise<void>((resolve) => (release = resolve))
	const seen = { resumes: 0, stops: [] as unknown[] }

	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stream`,
		(route) =>
			route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				body: sse([
					{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
					{ id: 2, event: 'background_tasks', data: { tasks: [SCRIPTED_TASK] } },
				]),
			}),
	)
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stream/resume`,
		async (route) => {
			seen.resumes++
			await resumeGate
			await route
				.fulfill({
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
					body: sse([{ event: 'done', data: { resumed: true, terminal: true } }]),
				})
				.catch(() => {
					// The page aborted this request (Stop); nothing left to answer.
				})
		},
	)
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stop`,
		async (route) => {
			seen.stops.push(route.request().postDataJSON())
			await route.fulfill({ json: { stopped: true } })
		},
	)
	return { seen, release: () => release() }
}

/** Open the conversation and send one message, which starts the scripted run. */
export async function openAndSend(page: Page, conversationId: string, text: string) {
	await page.goto('/', { waitUntil: 'domcontentloaded' })
	await page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' })
	const composer = page.getByPlaceholder('Message AgentStudio...')
	await composer.waitFor({ state: 'visible', timeout: 30_000 })
	await composer.fill(text)
	await page.getByRole('button', { name: /send message/i }).first().click()
}

/**
 * A conversation whose turn is already running: the send is refused with a 409 naming the
 * live run, and the page attaches to it through `stream/resume`. That request is held open,
 * like `scriptDroppedRun`'s, until `release()`.
 */
export async function scriptBusyRun(page: Page, conversationId: string, runId: string) {
	let release: () => void = () => {}
	const resumeGate = new Promise<void>((resolve) => (release = resolve))
	const seen = { sends: 0, resumes: [] as Array<{ since: string | null; runId: string | null }>, stops: [] as unknown[] }

	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stream`,
		(route) => {
			seen.sends++
			return route.fulfill({
				status: 409,
				json: { error: 'This conversation already has a turn in progress.', runId },
			})
		},
	)
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stream/resume`,
		async (route) => {
			const url = new URL(route.request().url())
			seen.resumes.push({ since: url.searchParams.get('since'), runId: url.searchParams.get('runId') })
			await resumeGate
			await route
				.fulfill({
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
					body: sse([{ id: 1, event: 'done', data: { error: 'Stopped' } }]),
				})
				.catch(() => {
					// The page aborted this request (Stop); nothing left to answer.
				})
		},
	)
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stop`,
		async (route) => {
			seen.stops.push(route.request().postDataJSON())
			await route.fulfill({ json: { stopped: true } })
		},
	)
	return { seen, release: () => release() }
}

/* Held runs for the page-state specs (chat.page-state, chat.ask-user-answers). */

export type Frame = { id?: number; event: string; data: unknown }

const isStream = (conversationId: string) => (url: URL) => url.pathname === `/chat/${conversationId}/stream`
const isResume = (conversationId: string) => (url: URL) => url.pathname === `/chat/${conversationId}/stream/resume`

/**
 * A run whose first response carries `frames` and then drops, so the page reconnects
 * through `stream/resume` — which is held open until `release()`, keeping the page mid-turn.
 */
export async function scriptHeldRun(page: Page, conversationId: string, frames: Frame[]) {
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => (release = resolve))
	const seen = { sends: [] as unknown[], resumes: 0, resumeAborted: false, stops: [] as unknown[] }

	page.on('requestfailed', (request) => {
		if (isResume(conversationId)(new URL(request.url()))) seen.resumeAborted = true
	})
	await page.route(isStream(conversationId), (route) => {
		seen.sends.push(route.request().postDataJSON())
		return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse(frames) })
	})
	await page.route(isResume(conversationId), async (route) => {
		seen.resumes++
		await gate
		await route
			.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				body: sse([{ event: 'done', data: { resumed: true, terminal: true } }]),
			})
			.catch(() => {
				// The page let go of the request; nothing left to answer.
			})
	})
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stop`,
		async (route) => {
			seen.stops.push(route.request().postDataJSON())
			await route.fulfill({ json: { stopped: true } })
		},
	)
	return { seen, release: () => release() }
}

/** A send whose response is held until `release()`, and then ends the turn. */
export async function scriptHeldSend(page: Page, conversationId: string) {
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => (release = resolve))
	const seen = { sends: [] as Array<Record<string, unknown>> }
	await page.route(isStream(conversationId), async (route) => {
		seen.sends.push(route.request().postDataJSON())
		await gate
		await route
			.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				body: sse([{ id: 1, event: 'done', data: { error: 'scripted end' } }]),
			})
			.catch(() => {
				// The page let go of the request; nothing left to answer.
			})
	})
	return { seen, release: () => release() }
}
