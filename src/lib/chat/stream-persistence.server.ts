/**
 * Post-stream persistence + fire-and-forget side effects, extracted from
 * `stream-prep.server.ts`. Together these handle everything that happens after
 * the LLM finishes:
 *   - resolveParentMessage: insert the user message (or look up the last one
 *     for regenerate flows) so the assistant message has a parent FK
 *   - persistAssistantMessage: insert (or update an existing partial-recovery
 *     row) the assistant message + bump conversation totals atomically
 *   - maybeGenerateTitle: kick off a title-gen call when this is the first
 *     exchange in a conversation
 *   - enqueueMemoryMineJob: queue the memory-palace mining pass
 *   - enqueueEvaluationJob: queue the evaluator if `evalRequired` was set
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { generateTitle } from '$lib/chat/chat.server'
import { logger } from '$lib/observability/logger'
import type { getSettings } from '$lib/settings'

type AppSettings = Awaited<ReturnType<typeof getSettings>>

export async function resolveParentMessage(input: {
	conversationId: string
	body: {
		regenerate?: boolean
		content?: string
		attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; url: string }>
	}
	model: string
}): Promise<{ ok: true; parentMessageId: string | null } | { ok: false; error: string }> {
	if (!input.body.regenerate) {
		if (!input.body.content || input.body.content.trim().length === 0) {
			return { ok: false, error: 'content is required when regenerate=false' }
		}
		const createdUser = await insertMessageWithSequence({
			conversationId: input.conversationId,
			role: 'user',
			content: input.body.content.trim(),
			model: input.model,
			metadata: {},
			toolCalls: [],
			attachments: input.body.attachments ?? [],
		})
		return { ok: true, parentMessageId: createdUser.id }
	}

	const [lastUser] = await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, input.conversationId), eq(messages.role, 'user')))
		.orderBy(desc(messages.sequence))
		.limit(1)
	return { ok: true, parentMessageId: lastUser?.id ?? null }
}

export type AssistantPersistInput = {
	conversationId: string
	parentMessageId: string | null
	model: string
	content: string
	promptTokens: number
	completionTokens: number
	ttftMs: number | null
	totalMs: number
	tokensPerSec: number | null
	cost: string
	metadata: Record<string, unknown>
	toolCalls: Array<Record<string, unknown>>
	runId: string
	conversationTotals: {
		previousTokens: number
		previousCost: string
	}
}

/**
 * Persist the final assistant message + bump conversation totals in a single
 * transaction. Detect-and-merge: if `savePartialAssistant` wrote a partial row
 * for this run (network-blip recovery path), update it in place instead of
 * inserting a second assistant row for the same logical turn — matched by
 * runId in metadata + the `partial` flag.
 *
 * Wrapping both the message write and the totals update in one transaction
 * means a crash between them can't leave the row + totals desynced.
 */
export async function persistAssistantMessage(input: AssistantPersistInput) {
	return db.transaction(async (tx) => {
		const [existingPartial] = await tx
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, input.conversationId),
					eq(messages.role, 'assistant'),
					sql`${messages.metadata}->>'runId' = ${input.runId}`,
					sql`${messages.metadata}->>'partial' = 'true'`,
				),
			)
			.limit(1)

		const written = existingPartial
			? (
					await tx
						.update(messages)
						.set({
							content: input.content,
							model: input.model,
							parentMessageId: input.parentMessageId,
							tokensIn: input.promptTokens,
							tokensOut: input.completionTokens,
							ttftMs: input.ttftMs,
							totalMs: input.totalMs,
							tokensPerSec: input.tokensPerSec,
							cost: input.cost,
							metadata: input.metadata,
							toolCalls: input.toolCalls,
						})
						.where(eq(messages.id, existingPartial.id))
						.returning()
				)[0]
			: await insertMessageWithSequence(
					{
						conversationId: input.conversationId,
						role: 'assistant',
						content: input.content,
						model: input.model,
						parentMessageId: input.parentMessageId,
						tokensIn: input.promptTokens,
						tokensOut: input.completionTokens,
						ttftMs: input.ttftMs,
						totalMs: input.totalMs,
						tokensPerSec: input.tokensPerSec,
						cost: input.cost,
						metadata: input.metadata,
						toolCalls: input.toolCalls,
					},
					tx,
				)

		await tx
			.update(conversations)
			.set({
				model: input.model,
				totalTokens:
					input.conversationTotals.previousTokens + input.promptTokens + input.completionTokens,
				totalCost: String(
					parseFloat(input.conversationTotals.previousCost) + parseFloat(input.cost),
				),
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, input.conversationId))

		return written
	})
}

/**
 * Fire-and-forget title generation for the first exchange of a conversation.
 * Sends the user message + assistant response to the title-gen model, then
 * writes the result back to `conversations.title`. Title-gen failures are
 * silently swallowed — the conversation keeps its default title and the
 * normal chat flow is unaffected.
 */
export function maybeGenerateTitle(input: {
	isFirstExchange: boolean
	userContent: string
	assistantContent: string
	conversationId: string
}): void {
	if (!input.isFirstExchange || !input.userContent.trim()) return
	void (async () => {
		try {
			const title = await generateTitle([
				{ role: 'user', content: input.userContent.trim() },
				{ role: 'assistant', content: input.assistantContent },
			])
			await db.update(conversations).set({ title }).where(eq(conversations.id, input.conversationId))
		} catch {
			// Non-critical — title stays as default.
		}
	})()
}

/**
 * Enqueue the memory-mining job for a conversation that just finished, when
 * the user has auto-mining enabled. DedupeKey collapses concurrent finishes
 * for the same conversation into one job; failures are visible in
 * /settings/jobs rather than silently swallowed.
 */
export function enqueueMemoryMineJob(input: {
	settings: AppSettings
	conversationId: string
	userId: string
	runId: string
}): void {
	const autoMine = (input.settings.memoryConfig as { autoMine?: boolean } | null)?.autoMine !== false
	if (!autoMine) return
	void (async () => {
		try {
			const { enqueueJob } = await import('$lib/jobs/jobs.server')
			await enqueueJob({
				type: 'memory_mine',
				queue: 'default',
				priority: 50, // background work — outranked by user-initiated jobs
				dedupeKey: `mine:${input.conversationId}`,
				payload: { conversationId: input.conversationId },
				userId: input.userId,
				runId: input.runId,
				sessionId: input.conversationId,
			})
		} catch (err) {
			logger.warn('[memory] enqueue mine job failed', { err })
		}
	})()
}

/**
 * Enqueue the evaluator pass for a finished run. Triggered when the run row
 * had `evalRequired = true`. The verdict shows up in the run viewer's
 * Evaluations panel asynchronously when the worker finishes (no SSE event).
 */
export function enqueueEvaluationJob(input: {
	runId: string
	userId: string
	conversationId: string
	userContent: string | undefined
	assistantContent: string
	toolCalls: Array<Record<string, unknown>>
}): void {
	void (async () => {
		try {
			const { enqueueJob } = await import('$lib/jobs/jobs.server')
			const toolSummary =
				input.toolCalls.length > 0
					? input.toolCalls.map((c) => (c as { name?: string }).name).filter(Boolean).join(', ')
					: undefined
			await enqueueJob({
				type: 'evaluation_run',
				queue: 'default',
				priority: 75, // higher than memory_mine (50), lower than user-initiated (100+)
				dedupeKey: `eval:${input.runId}`,
				payload: {
					runId: input.runId,
					userId: input.userId,
					conversationId: input.conversationId,
					taskDescription: input.userContent?.trim() ?? '(no user message)',
					generatorOutput: input.assistantContent,
					toolSummary,
				},
				userId: input.userId,
				runId: input.runId,
				sessionId: input.conversationId,
			})
		} catch (err) {
			logger.warn('[evaluations] enqueue evaluation_run job failed', { err })
		}
	})()
}
