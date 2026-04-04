import { json, type RequestHandler } from '@sveltejs/kit'
import { browserNavigate, browserScreenshot } from '$lib/server/tools/sandbox'

type BrowseAction = {
	type: 'navigate' | 'screenshot' | 'click' | 'type'
	url?: string
	selector?: string
	text?: string
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	return 'Unknown error'
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as BrowseAction

	try {
		if (body.type === 'navigate') {
			if (!body.url) {
				return json({ error: 'url required for navigate' }, { status: 400 })
			}
			const result = await browserNavigate(body.url)
			let screenshot: { mimeType: string; imageBase64: string } | null = null
			try {
				screenshot = await browserScreenshot()
			} catch {
				// Screenshot may fail even if navigation succeeded
			}
			return json({
				success: result.success,
				url: body.url,
				screenshot: screenshot?.imageBase64 ? `data:${screenshot.mimeType};base64,${screenshot.imageBase64}` : null,
			})
		}

		if (body.type === 'screenshot') {
			const screenshot = await browserScreenshot(body.url)
			return json({
				success: true,
				screenshot: screenshot.imageBase64 ? `data:${screenshot.mimeType};base64,${screenshot.imageBase64}` : null,
			})
		}

		return json({ error: `Unknown action: ${body.type}` }, { status: 400 })
	} catch (error) {
		return json({ success: false, error: `Sandbox browser unavailable: ${errorMessage(error)}` }, { status: 502 })
	}
}
