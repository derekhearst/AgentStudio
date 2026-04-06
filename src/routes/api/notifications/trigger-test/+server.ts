import { json, type RequestHandler } from '@sveltejs/kit'
import { createNotificationRecord, sendPushToAll } from '$lib/notifications/notifications.server'

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { title?: string; body?: string; url?: string; tag?: string }
	if (!body.title || !body.body) {
		return json({ error: 'title and body are required' }, { status: 400 })
	}

	const payload = {
		title: body.title,
		body: body.body,
		url: body.url,
		tag: body.tag,
	}
	const row = await createNotificationRecord(payload)
	const push = await sendPushToAll(payload)

	return json({ ok: true, row, push })
}

