import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveApproval } from '$lib/tools/tools.server'

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { token?: string; approved?: boolean }
	if (!body.token || typeof body.approved !== 'boolean') {
		return json({ error: 'token and approved are required' }, { status: 400 })
	}

	const resolved = resolveApproval(body.token, body.approved)
	return json({ resolved })
}

