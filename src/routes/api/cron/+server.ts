import { json, type RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { checkAndRunAutomations } from '$lib/automation/engine'

function hasCronAccess(request: Request) {
	const expected = env.CRON_SECRET?.trim()
	if (!expected) return true
	const auth = request.headers.get('authorization')
	if (!auth) return false
	const token = auth.replace(/^Bearer\s+/i, '').trim()
	return token === expected
}

export const POST: RequestHandler = async ({ request }) => {
	if (!hasCronAccess(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const result = await checkAndRunAutomations(new Date())
	return json(result)
}
