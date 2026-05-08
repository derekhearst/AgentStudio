import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { chat } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { logger } from '$lib/observability/logger'
import { getOrCreateAutomationConversation } from './conversation-utils.server'

/**
 * Wave 5 #21 phase 4 — maintenance-mode dispatch.
 *
 * Maintenance ticks are the "scheduled hygiene that doesn't belong in chat history" mode:
 * cleanup prompts, log digests, anything where filling up a conversation thread is noise.
 * Implementation: run the prompt as a single LLM synthesis call, log the cost ledger entry
 * for the run, and route the summary per `outputTarget`. We intentionally don't insert
 * user/assistant messages into any conversation by default — operators inspect maintenance
 * ticks via `automations.lifecycle.<status>` metrics + `/automations` last-run timestamps.
 */
export async function runMaintenanceModeAutomation(
	automation: typeof automations.$inferSelect,
	now: Date,
) {
	const settings = await getOrCreateSettings(automation.userId)
	const model = settings.defaultModel

	const prompt = `Maintenance run at ${now.toISOString()}\n\n${automation.prompt}`
	const response = await chat([{ role: 'user', content: prompt }], model)

	void logLlmUsage({
		source: 'automation',
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
		userId: automation.userId,
		agentId: automation.agentId ?? null,
		metadata: { automationId: automation.id, mode: 'maintenance' },
	}).catch(() => {})

	const fullSummary = (response.content ?? '').trim()
	const route = await routeMaintenanceOutput(automation, fullSummary, model, now).catch((err) => {
		logger.warn('[automations] output routing failed (non-fatal)', { err })
		return { target: 'none' as const }
	})

	return {
		conversationId:
			route.target === 'chat_session'
				? (route as { conversationId?: string }).conversationId ?? null
				: null,
		mode: 'maintenance' as const,
		summary: fullSummary.slice(0, 500),
		outputTarget: automation.outputTarget,
		routedTo: route.target,
		artifactId: 'artifactId' in route ? route.artifactId : null,
		reviewItemId: 'reviewItemId' in route ? route.reviewItemId : null,
	}
}

/**
 * Wave 5 #21 phase 4 (output routing) — maintenance-mode result destination.
 *
 * Each `outputTarget` enum value gets a destination:
 *   - `chat_session` (default): assistant message in the automation's conversation
 *   - `review_inbox`: `automation_summary` review item (deduped per-hour by automation id)
 *   - `artifact`: new versioned artifact in the conversation's bound project (skipped + logged
 *     with a clear marker if no project is bound, since artifacts require one)
 *
 * Best-effort: failures are caught at the caller so a routing hiccup never invalidates the
 * already-completed maintenance work.
 */
async function routeMaintenanceOutput(
	automation: typeof automations.$inferSelect,
	summary: string,
	model: string,
	now: Date,
): Promise<
	| { target: 'chat_session'; conversationId: string }
	| { target: 'review_inbox'; reviewItemId: string | null }
	| { target: 'artifact'; artifactId: string }
	| { target: 'artifact_skipped'; reason: string }
	| { target: 'none' }
> {
	const trimmed = summary.length > 0 ? summary : '(no output)'

	if (automation.outputTarget === 'review_inbox') {
		const { openReviewItem } = await import('$lib/observability/review.server')
		const item = await openReviewItem({
			type: 'automation_summary',
			severity: 'info',
			summary: `Maintenance: ${automation.description.slice(0, 100)}`,
			payload: {
				kind: 'maintenance_summary',
				automationId: automation.id,
				summary: trimmed.slice(0, 4000),
				mode: 'maintenance',
			},
			// One open item per automation per hour — back-to-back ticks within an hour
			// collapse to a single inbox row instead of flooding the queue.
			dedupeKey: `automation_summary:${automation.id}:${now.toISOString().slice(0, 13)}`,
		})
		return { target: 'review_inbox', reviewItemId: item?.id ?? null }
	}

	if (automation.outputTarget === 'artifact') {
		const conversation = await getOrCreateAutomationConversation(automation)
		if (!conversation.projectId) {
			logger.info(
				'[automations] outputTarget=artifact but conversation has no project bound; skipping',
				{
					automationId: automation.id,
					conversationId: conversation.id,
				},
			)
			return { target: 'artifact_skipped', reason: 'no project bound to automation conversation' }
		}
		const { createArtifact } = await import('$lib/projects/projects.server')
		const artifact = await createArtifact({
			projectId: conversation.projectId,
			name: `${automation.description.slice(0, 80)} (${now.toISOString().slice(0, 10)})`,
			contentType: 'markdown',
			content: trimmed,
			changeNote: `Maintenance run at ${now.toISOString()}`,
			editedBy: automation.userId,
		})
		return { target: 'artifact', artifactId: artifact.id }
	}

	// chat_session (default) — append the summary into the automation's conversation as
	// an assistant message. Differs from chat_followup mode because we don't insert the
	// user prompt; only the summary lands so the conversation isn't littered with the
	// "Maintenance run at …" header lines.
	const conversation = await getOrCreateAutomationConversation(automation)
	await insertMessageWithSequence({
		conversationId: conversation.id,
		role: 'assistant',
		content: trimmed,
		model,
		metadata: { source: 'automation_maintenance', automationId: automation.id, mode: 'maintenance' },
	})
	await db
		.update(conversations)
		.set({ updatedAt: now })
		.where(eq(conversations.id, conversation.id))
	return { target: 'chat_session', conversationId: conversation.id }
}
