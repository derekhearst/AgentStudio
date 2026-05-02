import { json, type RequestHandler } from '@sveltejs/kit'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { recordQuestionAnswers } from '$lib/runs/questions.server'

const RESOLVABLE_STATES = ['running', 'waiting_user_input'] as const

type AskUserBody = {
	token?: string
	answers?: Record<string, string>
}

export const POST: RequestHandler = async ({ request, params, locals }) => {
	try {
		if (!locals.user) {
			return json({ error: 'Unauthorized' }, { status: 401 })
		}
		if (!params.id) {
			return json({ error: 'conversationId is required' }, { status: 400 })
		}

		const body = (await request.json()) as AskUserBody
		if (!body.token || !body.answers || typeof body.answers !== 'object') {
			console.warn('[chat/ask-user] Invalid request payload', {
				conversationId: params.id,
				userId: locals.user.id,
				body,
			})
			return json({ error: 'token and answers are required' }, { status: 400 })
		}

		const normalizedAnswers = Object.fromEntries(
			Object.entries(body.answers)
				.filter(([key, value]) => key.trim().length > 0 && typeof value === 'string')
				.map(([key, value]) => [key, value.trim()]),
		)

		if (Object.keys(normalizedAnswers).length === 0) {
			console.warn('[chat/ask-user] Empty normalized answers', {
				conversationId: params.id,
				userId: locals.user.id,
				token: body.token,
			})
			return json({ error: 'answers must include at least one value' }, { status: 400 })
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
					sql`${chatRuns.pendingQuestions} @> ${tokenJson}::jsonb`,
				),
			)
			.limit(1)

		if (!run) {
			console.warn('[chat/ask-user] ask_user token not found in any active run', {
				conversationId: params.id,
				userId: locals.user.id,
				token: body.token,
				answerCount: Object.keys(normalizedAnswers).length,
			})
			return json({ resolved: false })
		}

		const result = await recordQuestionAnswers(run.id, body.token, normalizedAnswers)
		if (!result.resolved) {
			console.warn('[chat/ask-user] ask_user already resolved or missing', {
				conversationId: params.id,
				userId: locals.user.id,
				runId: run.id,
				token: body.token,
			})
		}
		return json({ resolved: result.resolved })
	} catch (error) {
		console.error('[chat/ask-user] Failed to resolve ask_user answers', {
			conversationId: params.id,
			userId: locals.user?.id ?? null,
			error: error instanceof Error ? error.message : String(error),
		})
		return json({ error: 'Failed to resolve ask_user answers' }, { status: 500 })
	}
}
