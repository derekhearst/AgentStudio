import { json, type RequestHandler } from '@sveltejs/kit'
import { resolvePlanDecision, type PlanDecision } from '$lib/tools/tools.server'

type PlanDecisionBody = {
	token?: string
	decision?: PlanDecision
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as PlanDecisionBody
	if (!body.token || !body.decision) {
		return json({ error: 'token and decision are required' }, { status: 400 })
	}
	if (!['approve', 'deny', 'continue'].includes(body.decision)) {
		return json({ error: 'decision must be approve, deny, or continue' }, { status: 400 })
	}

	const resolved = resolvePlanDecision(body.token, body.decision)
	return json({ resolved })
}
