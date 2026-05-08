import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { buildAgentDefinition, createDetachedSession, runChatLoop } from '$lib/runtime'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { getOrCreateAutomationConversation } from './conversation-utils.server'

/**
 * Default automation mode (`chat_followup`) — runs the prompt as a chat reply in the
 * automation's bound conversation. When an agent is attached we route through the full
 * runtime loop (multi-round, tool execution, capability disclosure); otherwise we use the
 * legacy single-shot synthesis path.
 */
export async function runChatFollowupAutomation(
	automation: typeof automations.$inferSelect,
	now: Date,
) {
	const conversation = await getOrCreateAutomationConversation(automation)
	const [agent] = automation.agentId
		? await db.select().from(agents).where(eq(agents.id, automation.agentId)).limit(1)
		: [null]
	const settings = await getOrCreateSettings(automation.userId)
	const model = agent?.model ?? settings.defaultModel

	const history = await db
		.select({ role: messages.role, content: messages.content })
		.from(messages)
		.where(eq(messages.conversationId, conversation.id))
		.orderBy(asc(messages.sequence))
		.limit(12)

	const prompt = `Automation run at ${now.toISOString()}\n\n${automation.prompt}`
	await insertMessageWithSequence({
		conversationId: conversation.id,
		role: 'user',
		content: prompt,
		model,
	})

	if (agent) {
		return runAutomationWithAgent({ automation, conversation, agent, history, prompt, model, now })
	}
	return runAutomationSynthesis({ automation, conversation, history, prompt, model, now })
}

/** Single-shot LLM synthesis — used when no agent is attached. */
async function runAutomationSynthesis(args: {
	automation: typeof automations.$inferSelect
	conversation: typeof conversations.$inferSelect
	history: Array<{ role: string; content: string }>
	prompt: string
	model: string
	now: Date
}) {
	const { automation, conversation, history, prompt, model, now } = args

	const llmMessages: LlmMessage[] = []
	for (const item of history) {
		if (item.role === 'system' || item.role === 'user' || item.role === 'assistant') {
			llmMessages.push({ role: item.role, content: item.content })
		}
	}
	llmMessages.push({ role: 'user', content: prompt })

	const response = await chat(llmMessages, model)
	await insertMessageWithSequence({
		conversationId: conversation.id,
		role: 'assistant',
		content: response.content,
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	})

	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversation.id))

	void logLlmUsage({
		source: 'agent_synthesis',
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
		userId: automation.userId,
		agentId: automation.agentId ?? null,
	}).catch(() => {})

	return { conversationId: conversation.id }
}

/**
 * Full agent-loop automation — slot-assembled system prompt, tool surface, multi-round
 * execution via the shared runtime. The session is detached (no SSE consumer), so events
 * land in run_events / chat_runs only.
 */
async function runAutomationWithAgent(args: {
	automation: typeof automations.$inferSelect
	conversation: typeof conversations.$inferSelect
	agent: typeof agents.$inferSelect
	history: Array<{ role: string; content: string }>
	prompt: string
	model: string
	now: Date
}) {
	const { automation, conversation, agent, history, prompt, model, now } = args

	// Wave 2 #10 phase 2 — slot assembly + workspace context resolved by the runtime.
	const definition = await buildAgentDefinition({
		agent,
		userId: automation.userId,
		intent: prompt,
		toolPolicy: [
			'Automation policy:',
			'- This is a scheduled automation tick — there is no user to ask in real time.',
			'- Complete the work, then summarize what you did. If you need user input, leave a clear note for the next manual review.',
		].join('\n'),
	})

	const llmMessages: LlmMessage[] = [{ role: 'system', content: definition.systemPrompt }]
	for (const item of history) {
		if (item.role === 'user' || item.role === 'assistant') {
			llmMessages.push({ role: item.role, content: item.content })
		}
	}
	llmMessages.push({ role: 'user', content: prompt })

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: conversation.id,
			userId: automation.userId,
			agentId: agent.id,
			state: 'running',
			source: 'automation',
			label: `Automation tick: ${automation.description.slice(0, 80)}`,
			startedAt: now,
			lastHeartbeatAt: now,
		})
		.returning({ id: chatRuns.id })

	const session = createDetachedSession({ runId: run.id })

	try {
		const loopResult = await runChatLoop({
			session,
			userId: automation.userId,
			conversationId: conversation.id,
			model,
			initialMessages: llmMessages,
			initialTools: definition.tools,
			computeTools: async () => definition.tools,
			maxRounds: 10, // automations are bounded — no human in the loop to course-correct
			approvalRequiredTools: new Set<string>(), // no approval surface in a detached run
			isOrchestrator: false,
			agentId: agent.id,
			persistentKey: definition.persistentKey,
			worktree: definition.worktree,
			projectId: conversation.projectId ?? null,
			spawnSubagent: undefined,
		})

		const cost = await logLlmUsage({
			source: 'automation',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId: automation.userId,
			runId: run.id,
			agentId: agent.id,
			metadata: { conversationId: conversation.id, automationId: automation.id },
		}).catch(() => '0')

		await insertMessageWithSequence({
			conversationId: conversation.id,
			role: 'assistant',
			content: loopResult.finalText || '(no output)',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			cost,
			toolCalls: loopResult.toolCalls,
			metadata: {
				blocks: loopResult.streamBlocks.length > 0 ? loopResult.streamBlocks : undefined,
				automationId: automation.id,
				runId: run.id,
			},
		})

		await db
			.update(conversations)
			.set({ updatedAt: now })
			.where(eq(conversations.id, conversation.id))

		await session.updateRun({
			state: 'completed',
			label: 'Automation completed',
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})

		return { conversationId: conversation.id, runId: run.id }
	} catch (error) {
		await session.updateRun({
			state: 'failed',
			label: 'Automation failed',
			error: error instanceof Error ? error.message : 'Automation run failed',
			finished: true,
		})
		throw error
	}
}
