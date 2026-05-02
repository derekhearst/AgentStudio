import { json, type RequestHandler } from '@sveltejs/kit'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { recordApprovalDecision } from '$lib/runs/approvals.server'

const RESOLVABLE_STATES = ['running', 'waiting_tool_approval'] as const

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
			console.warn('[chat/tool-approve] Invalid request payload', {
				conversationId: params.id,
				userId: locals.user.id,
				body,
			})
			return json({ error: 'token and approved are required' }, { status: 400 })
		}

		const tokenJson = JSON.stringify([{ token: body.token }])
		const [run] = await db
			.select({ id: chatRuns.id })
			.from(chatRuns)
			.where(
				and(
					eq(chatRuns.conversationId, params.id),
					eq(chatRuns.userId, locals.user.id),
					inArray(chatRuns.state, RESOLVABLE_STATES),
					sql`${chatRuns.pendingApprovals} @> ${tokenJson}::jsonb`,
				),
			)
			.limit(1)

		if (!run) {
			console.warn('[chat/tool-approve] Approval token not found in any active run', {
				conversationId: params.id,
				userId: locals.user.id,
				token: body.token,
				approved: body.approved,
			})
			return json({ resolved: false })
		}

		const result = await recordApprovalDecision(run.id, body.token, body.approved)
		if (!result.resolved) {
			console.warn('[chat/tool-approve] Approval already resolved or missing', {
				conversationId: params.id,
				userId: locals.user.id,
				runId: run.id,
				token: body.token,
				approved: body.approved,
			})
		}
		return json({ resolved: result.resolved })
	} catch (error) {
		console.error('[chat/tool-approve] Failed to resolve tool approval', {
			conversationId: params.id,
			userId: locals.user?.id ?? null,
			error: error instanceof Error ? error.message : String(error),
		})
		return json({ error: 'Failed to resolve tool approval' }, { status: 500 })
	}
}
