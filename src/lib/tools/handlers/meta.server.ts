/**
 * "Meta" tool handlers — tools that operate on the runtime/loop itself rather than
 * an external resource:
 *   - search_tools: free-text query over the registry; matches load into the next round
 *   - request_plan_approval: planner→implementer agent handoff (mandatory approval)
 *   - ask_user: only the chat-stream loop fulfills this; the dispatcher reaches it as a
 *     defensive fallback (e.g. someone executes the tool directly without going through
 *     the loop) — return a 'not directly executable' error.
 *   - run_code: programmatic-tool-calling subprocess (delegates to run-code.server)
 *   - run_subagent: stateless one-shot LLM call — used as a fallback when the
 *     orchestrator-only path isn't available (the loop has its own special-case branch
 *     that uses spawnSubagent for full agent dispatch).
 */

import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { searchToolsRegistry, toolSchemas } from '../tool-schemas'
import { toolUserContext } from '../sandbox.server'
import { resolveConversationFromRunId } from '../artifact-scope.server'
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

	search_tools: async (call, { startedAt }) => {
		const input = toolSchemas.search_tools.parse(call.arguments)
		const ctx = toolUserContext.getStore()
		const hits = searchToolsRegistry(input.query, input.limit ?? 10)
		// Register matches into the per-run loaded set so they appear in the tools array
		// on the next round. Done via a callback the runtime exposes — the runtime owns
		// the actual Set and refreshes its computeTools() each round.
		const matchedNames = hits.map((h) => h.name)
		if (matchedNames.length > 0 && ctx?.runtime?.loadSearchableTools) {
			try {
				ctx.runtime.loadSearchableTools(matchedNames)
			} catch (err) {
				logger.warn('[search_tools] loadSearchableTools callback threw', { err })
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: {
				matches: hits.map((h) => ({ name: h.name, description: h.description })),
				note:
					matchedNames.length === 0
						? `No tools matched "${input.query}". Try different keywords or check the spelling.`
						: `Loaded ${matchedNames.length} tool${matchedNames.length === 1 ? '' : 's'} for the next round: ${matchedNames.join(', ')}. Call them on the next turn — they're now in your tools array.`,
			},
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

		const projectsModule = await import('$lib/projects/projects.server')
		const artifact = await projectsModule.getArtifactById(input.artifactId)
		if (!artifact) {
			return {
				success: false,
				tool: call.name,
				error: `Artifact ${input.artifactId} not found`,
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
		if (artifact.conversationId && artifact.conversationId !== conversationId) {
			return {
				success: false,
				tool: call.name,
				error: 'Artifact does not belong to this conversation.',
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
				approvedArtifactId: input.artifactId,
			})
			return {
				success: true,
				tool: call.name,
				input,
				result: {
					approved: true,
					switchedToAgentId: result.agentId,
					previousAgentId: result.previousAgentId,
					artifactId: input.artifactId,
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

	run_code: async (call, { startedAt }) => {
		const input = toolSchemas.run_code.parse(call.arguments)
		const { runCodeTool } = await import('../run-code.server')
		try {
			const result = await runCodeTool({ code: input.code, timeoutMs: input.timeoutMs })
			return {
				success: result.exitCode === 0 && !result.timedOut,
				tool: call.name,
				input,
				result,
				error: result.timedOut
					? `run_code timed out after ${result.durationMs}ms`
					: result.exitCode !== 0
						? `run_code exited with code ${result.exitCode}: ${result.stderr.slice(-1000) || 'no stderr'}`
						: undefined,
				executionMs: Date.now() - startedAt,
			}
		} catch (err) {
			return {
				success: false,
				tool: call.name,
				input,
				error: err instanceof Error ? err.message : String(err),
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
		const response = await llmChat(subagentMessages, 'anthropic/claude-sonnet-4')
		return {
			success: true,
			tool: call.name,
			input,
			result: response.content,
			executionMs: Date.now() - startedAt,
		}
	},
}
