import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import type { LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { buildAgentDefinition, createForwardedSession, runChatLoop } from '$lib/runtime'
import { encodeSseFrame } from '$lib/runtime/sse-codec'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'

export type SubagentStep = {
	agentId: string
	agentName: string
	task: string
}

/**
 * Run a sub-agent inline within the orchestrator's stream.
 *
 * Wave 2 #10 phase 5 — refactored to route through `runChatLoop` with a forwarded Session
 * (events get a `subagent_` prefix on their way to the parent's controller). The shed ~250
 * lines of for-round duplication.
 *
 * Contract preserved from before extraction:
 *   - Creates a fresh sub-conversation under the agent
 *   - Inserts a `chat_runs` row with source='agent_subagent'
 *   - Emits `subagent_start` → loop events (translated by the forwarded Session) → `subagent_done`
 *   - Returns `{ result, conversationId, cost }` to the orchestrator's `run_subagent` tool result
 *   - Sub-agents that try to call `ask_user` get an error tool_result inside the loop (handled by
 *     runChatLoop when `isOrchestrator: false`); they don't reach the actual user
 */
export async function runInlineSubagent(
	step: SubagentStep,
	userId: string,
	parentConversationId: string,
	controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<{ result: string; conversationId: string; cost: string }> {
	const [agent] = await db.select().from(agents).where(eq(agents.id, step.agentId)).limit(1)
	if (!agent) {
		throw new Error(`Agent not found: ${step.agentId}`)
	}

	// Wave 2 #10 phase 2 — slot assembly + workspace context resolved by the runtime.
	const definition = await buildAgentDefinition({
		agent,
		userId,
		intent: step.task,
		toolPolicy: [
			'Agent collaboration policy:',
			'- You cannot ask the user directly with ask_user.',
			'- If you need user input, return a concise handoff for orchestrator with missing information and proposed options.',
			'- Once orchestrator returns answers in context, continue execution immediately.',
		].join('\n'),
	})

	// Inherit the parent conversation's project binding so sub-agents work inside the same
	// sandboxed project repo. Sub-agents that don't have a parent project simply run with
	// the default ephemeral workspace.
	const [parentConversation] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(eq(conversations.id, parentConversationId))
		.limit(1)

	// Create a conversation for this sub-agent run + its chat_runs row.
	const [subConversation] = await db
		.insert(conversations)
		.values({
			title: step.task.slice(0, 80),
			userId,
			agentId: agent.id,
			model: agent.model,
			projectId: parentConversation?.projectId ?? null,
		})
		.returning()

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: subConversation.id,
			userId,
			agentId: agent.id,
			state: 'running',
			source: 'agent_subagent',
			label: `Subagent ${agent.name} running`,
			startedAt: new Date(),
			lastHeartbeatAt: new Date(),
		})
		.returning({ id: chatRuns.id })

	// Subagent-specific lifecycle event: announce the start to the parent UI.
	controller.enqueue(
		encodeSseFrame('subagent_start', {
			agentId: agent.id,
			agentName: agent.name,
			conversationId: subConversation.id,
			task: step.task,
		}),
	)

	// Save the task as the user message in the sub-agent conversation.
	await insertMessageWithSequence({
		conversationId: subConversation.id,
		role: 'user',
		content: step.task,
		metadata: { source: 'orchestrator', parentConversationId },
	})

	const subMessages: LlmMessage[] = [
		{ role: 'system', content: definition.systemPrompt },
		{ role: 'user', content: step.task },
	]

	const session = createForwardedSession({ runId: run.id, parentController: controller })

	try {
		const loopResult = await runChatLoop({
			session,
			userId,
			conversationId: subConversation.id,
			model: agent.model,
			initialMessages: subMessages,
			initialTools: definition.tools,
			computeTools: async () => definition.tools,
			maxRounds: 20,
			// Sub-agents bypass tool approval — they're already running under the orchestrator's
			// approved scope. Adding approval here would deadlock (no UI surface to approve in).
			approvalRequiredTools: new Set<string>(),
			isOrchestrator: false,
			agentId: agent.id,
			persistentKey: definition.persistentKey,
			worktree: definition.worktree,
			// Sub-agents inherit the parent conversation's project binding (looked up in caller scope
			// — the parent conversation's projectId is visible via subConversation if persisted).
			projectId: subConversation.projectId ?? null,
			// Sub-agents don't spawn their own sub-agents in this flow.
			spawnSubagent: undefined,
		})

		const cost = await logLlmUsage({
			source: 'subagent',
			model: agent.model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId,
			runId: run.id,
			agentId: agent.id,
			metadata: { conversationId: subConversation.id, parentConversationId },
		}).catch(() => '0')

		await insertMessageWithSequence({
			conversationId: subConversation.id,
			role: 'assistant',
			content: loopResult.finalText || '(no output)',
			model: agent.model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			cost,
		})

		await db
			.update(conversations)
			.set({
				totalTokens: loopResult.promptTokens + loopResult.completionTokens,
				totalCost: cost,
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, subConversation.id))

		await session.updateRun({
			state: 'completed',
			label: `Subagent ${agent.name} completed`,
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})

		controller.enqueue(
			encodeSseFrame('subagent_done', {
				agentId: agent.id,
				agentName: agent.name,
				conversationId: subConversation.id,
				resultPreview: loopResult.finalText.slice(0, 500),
			}),
		)

		return {
			result: loopResult.finalText,
			conversationId: subConversation.id,
			cost,
		}
	} catch (error) {
		await session.updateRun({
			state: 'failed',
			label: `Subagent ${agent.name} failed`,
			error: error instanceof Error ? error.message : 'Subagent execution failed',
			finished: true,
		})
		throw error
	}
}
