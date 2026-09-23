/**
 * "Meta" tool handlers — tools that operate on the runtime/loop itself rather than
 * an external resource:
 *   - request_plan_approval: planner→implementer agent handoff (mandatory approval)
 *   - ask_user: only the chat-stream loop fulfills this; the dispatcher reaches it as a
 *     defensive fallback (e.g. someone executes the tool directly without going through
 *     the loop) — return a 'not directly executable' error.
 *   - run_subagent: stateless one-shot LLM call — used as a fallback when the
 *     orchestrator-only path isn't available (the loop has its own special-case branch
 *     that uses spawnSubagent for full agent dispatch).
 */

import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { toolSchemas } from '../tool-schemas'
import { toolUserContext } from '../sandbox.server'
import { resolveConversationFromRunId } from '../run-scope.server'
import { logger } from '$lib/observability/logger'
import type { ToolHandler } from '../handler-types'

export const metaHandlers: Record<string, ToolHandler> = {
	ask_user: async (call, { startedAt }) => {
		const input = toolSchemas.ask_user.parse(call.arguments)
		return {
			success: false,
			tool: call.name,
			input,
			error: 'ask_user must be handled by chat streaming flow and cannot run directly.',
			executionMs: Date.now() - startedAt,
		}
	},

	request_plan_approval: async (call, { startedAt }) => {
		const input = toolSchemas.request_plan_approval.parse(call.arguments)
		// Mandatory-approval tool — by the time the executor runs, the user has approved
		// in the inline card. Switch the conversation's bound agent to the implementer so
		// the next round runs under that agent.
		const ctx = toolUserContext.getStore()
		if (!ctx?.userId) {
			return {
				success: false,
				tool: call.name,
				error: 'request_plan_approval requires an authenticated userId in the tool execution context.',
				executionMs: Date.now() - startedAt,
			}
		}
		if (!ctx.runId) {
			return {
				success: false,
				tool: call.name,
				error: 'request_plan_approval can only run inside a chat run.',
				executionMs: Date.now() - startedAt,
			}
		}

		// The plan is a file in the workspace. Reading it here both validates the
		// path and fails closed before the agent
		// handoff if the planner referenced a file it never wrote. Path traversal is
		// the sandbox's problem — fileRead resolves inside the workspace root.
		let planContent: string
		try {
			const { fileRead } = await import('$lib/tools/sandbox-fs.server')
			planContent = await fileRead(input.path)
		} catch (err) {
			return {
				success: false,
				tool: call.name,
				error: `Could not read plan file "${input.path}": ${err instanceof Error ? err.message : String(err)}`,
				executionMs: Date.now() - startedAt,
			}
		}

		const conversationId = await resolveConversationFromRunId(ctx.runId)
		if (!conversationId) {
			return {
				success: false,
				tool: call.name,
				error: 'Unable to resolve the conversation for this run.',
				executionMs: Date.now() - startedAt,
			}
		}

		const { agents: agentsTable } = await import('$lib/agents/agents.schema')
		const [implementer] = await db
			.select({ id: agentsTable.id, name: agentsTable.name })
			.from(agentsTable)
			.where(eq(agentsTable.id, input.implementerAgentId))
			.limit(1)
		if (!implementer) {
			return {
				success: false,
				tool: call.name,
				error: `Implementer agent ${input.implementerAgentId} not found`,
				executionMs: Date.now() - startedAt,
			}
		}

		try {
			const { setConversationAgent } = await import('$lib/chat/agent-switch.server')
			const result = await setConversationAgent(conversationId, input.implementerAgentId, {
				userId: ctx.userId,
				approvedPlanPath: input.path,
			})
			return {
				success: true,
				tool: call.name,
				input,
				result: {
					approved: true,
					switchedToAgentId: result.agentId,
					previousAgentId: result.previousAgentId,
					planPath: input.path,
					implementerName: implementer.name,
				},
				executionMs: Date.now() - startedAt,
			}
		} catch (err) {
			logger.error('[request_plan_approval] agent switch failed', { err })
			return {
				success: false,
				tool: call.name,
				error: err instanceof Error ? err.message : 'Agent switch failed',
				executionMs: Date.now() - startedAt,
			}
		}
	},

	run_subagent: async (call, { startedAt }) => {
		const input = toolSchemas.run_subagent.parse(call.arguments)
		const { chat: llmChat } = await import('$lib/llm/chat.server')
		const subagentMessages = [
			{
				role: 'system' as const,
				content: 'You are a focused subagent. Complete the given task and return a clear, concise result.',
			},
			{
				role: 'user' as const,
				content: input.context ? `Context: ${input.context}\n\nTask: ${input.task}` : `Task: ${input.task}`,
			},
		]
		const response = await llmChat(subagentMessages, 'claude-sonnet-5')
		const { wrapSubagentResult } = await import('$lib/agents/subagent-result')
		return {
			success: true,
			tool: call.name,
			input,
			// #34 — child output is data reported to the parent, wrapped so it cannot read as
			// the parent's own instructions and cannot forge the wrapper itself.
			result: wrapSubagentResult(response.content),
			executionMs: Date.now() - startedAt,
		}
	},
}
