import { json, type RequestHandler } from '@sveltejs/kit'
import { findRunAwaitingApproval, recordApprovalDecision } from '$lib/runs/approvals.server'
import { logger } from '$lib/observability/logger'

export const POST: RequestHandler = async ({ request, params, locals }) => {
	try {
		if (!locals.user) {
			return json({ error: 'Unauthorized' }, { status: 401 })
		}
		if (!params.id) {
			return json({ error: 'conversationId is required' }, { status: 400 })
		}

		const body = (await request.json()) as { token?: string; approved?: boolean }
		if (!body.token || typeof body.approved !== 'boolean') {
			logger.warn('[chat/tool-approve] Invalid request payload', {
				conversationId: params.id,
				userId: locals.user.id,
				body,
			})
			return json({ error: 'token and approved are required' }, { status: 400 })
		}

		// Waits briefly: the card can reach the operator a moment before its approval is
		// recorded. See `findRunAwaitingApproval`.
		const runId = await findRunAwaitingApproval({
			conversationId: params.id,
			userId: locals.user.id,
			token: body.token,
		})

		if (!runId) {
			logger.warn('[chat/tool-approve] Approval token not found in any active run', {
				conversationId: params.id,
				userId: locals.user.id,
				token: body.token,
				approved: body.approved,
			})
			return json({ resolved: false })
		}

		const result = await recordApprovalDecision(runId, body.token, body.approved)
		if (!result.resolved) {
			logger.warn('[chat/tool-approve] Approval already resolved or missing', {
				conversationId: params.id,
				userId: locals.user.id,
				runId,
				token: body.token,
				approved: body.approved,
			})
		}
		return json({ resolved: result.resolved })
	} catch (error) {
		logger.error('[chat/tool-approve] Failed to resolve tool approval', {
			conversationId: params.id,
			userId: locals.user?.id ?? null,
			error: error instanceof Error ? error.message : String(error),
		})
		return json({ error: 'Failed to resolve tool approval' }, { status: 500 })
	}
}
