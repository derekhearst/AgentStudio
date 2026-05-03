import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import type { LlmMessage } from '$lib/llm/chat.server'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { logLlmUsage } from '$lib/costs/usage'
import { listSkillSummaries } from '$lib/skills/skills.server'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { assembleSystemPrompt, type ContextSlot } from '$lib/context/slots.server'
import { createForwardedSession, runChatLoop } from '$lib/runtime'

const encoder = new TextEncoder()

function sse(name: string, payload: unknown) {
	return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
}

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

	// Phase 2 of #7: opt-in persistent workspace per agent.
	// Phase 4 of #7: opt-in git-worktree workspace per agent.
	const agentConfigForWs = agent.config as
		| {
				workspace?: {
					mode?: string
					key?: string
					repoPath?: string
					baseBranch?: string
					deleteBranchOnCleanup?: boolean
				}
		  }
		| null
	const persistentKey =
		agentConfigForWs?.workspace?.mode === 'persistent' &&
		typeof agentConfigForWs.workspace.key === 'string' &&
		agentConfigForWs.workspace.key.length > 0
			? agentConfigForWs.workspace.key
			: null
	const worktreeConfig =
		agentConfigForWs?.workspace?.mode === 'worktree' &&
		typeof agentConfigForWs.workspace.repoPath === 'string' &&
		agentConfigForWs.workspace.repoPath.length > 0
			? {
					repoPath: agentConfigForWs.workspace.repoPath,
					baseBranch: agentConfigForWs.workspace.baseBranch,
					deleteBranchOnCleanup: agentConfigForWs.workspace.deleteBranchOnCleanup,
				}
			: null

	// Create a conversation for this sub-agent run + its chat_runs row.
	const [subConversation] = await db
		.insert(conversations)
		.values({
			title: step.task.slice(0, 80),
			userId,
			agentId: agent.id,
			model: agent.model,
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
		sse('subagent_start', {
			agentId: agent.id,
			agentName: agent.name,
			conversationId: subConversation.id,
			task: step.task,
		}),
	)

	// Save the task as the user message in the sub-agent conversation.
	await db.insert(messages).values({
		conversationId: subConversation.id,
		role: 'user',
		content: step.task,
		metadata: { source: 'orchestrator', parentConversationId },
	})

	// Build sub-agent context using the slot system + skill summaries + memory recall.
	const slots: ContextSlot[] = [
		{ name: 'identity', priority: 100, content: agent.systemPrompt },
		{ name: 'role', priority: 95, content: `Your role: ${agent.role}` },
		{
			name: 'tool_policy',
			priority: 90,
			content: [
				'Agent collaboration policy:',
				'- You cannot ask the user directly with ask_user.',
				'- If you need user input, return a concise handoff for orchestrator with missing information and proposed options.',
				'- Once orchestrator returns answers in context, continue execution immediately.',
			].join('\n'),
		},
	]

	const skillSummaries = await listSkillSummaries()
	if (skillSummaries.length > 0) {
		const text = skillSummaries
			.map((s) => {
				const fileNames = s.files.map((f) => f.name).join(', ')
				return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
			})
			.join('\n')
		slots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load):\n${text}`,
			truncationStrategy: 'truncate-end',
		})
	}

	// Phase 6 of #4: bring relevant memory into the sub-agent's context so it can pick up where
	// prior conversations left off, not start from a blank slate. Best-effort.
	try {
		const settings = await getOrCreateSettings(userId)
		const memoryConfig = (settings.memoryConfig ?? null) as {
			enabled?: boolean
			topK?: number
			useRerank?: boolean
			rerankModel?: string
		} | null
		const memoryEnabled = memoryConfig?.enabled !== false
		if (memoryEnabled && step.task && step.task.trim().length > 0) {
			const recalled = await recallForUser(userId, step.task.trim(), {
				topK: memoryConfig?.topK ?? 5,
				useRerank: memoryConfig?.useRerank ?? false,
				rerankModel: memoryConfig?.rerankModel,
			})
			const memoryBlock = renderMemoryContext(recalled)
			if (memoryBlock) {
				slots.push({
					name: 'memory',
					priority: 60,
					content: memoryBlock,
					truncationStrategy: 'truncate-end',
				})
			}
		}
	} catch (err) {
		console.warn('[subagent] memory recall failed', err)
	}

	const subMessages: LlmMessage[] = [
		{ role: 'system', content: assembleSystemPrompt(slots).systemPrompt },
		{ role: 'user', content: step.task },
	]

	// Sub-agents always get the full tool surface minus ask_user (they can't reach the user).
	// Progressive disclosure isn't applied here; the sub-agent has a focused single-shot task.
	const tools = getToolDefinitions().filter((t) => t.function.name !== 'ask_user')

	const session = createForwardedSession({ runId: run.id, parentController: controller })

	try {
		const loopResult = await runChatLoop({
			session,
			userId,
			conversationId: subConversation.id,
			model: agent.model,
			initialMessages: subMessages,
			initialTools: tools,
			computeTools: async () => tools,
			maxRounds: 20,
			// Sub-agents bypass tool approval — they're already running under the orchestrator's
			// approved scope. Adding approval here would deadlock (no UI surface to approve in).
			approvalRequiredTools: new Set<string>(),
			isOrchestrator: false,
			persistentKey,
			worktree: worktreeConfig,
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

		await db.insert(messages).values({
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
			sse('subagent_done', {
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
