import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { streamChat, type LlmMessage } from '$lib/llm/chat.server'
import {
	executeTool,
	getToolDefinitions,
	toolSchemas,
	type ToolCallWithContext,
	type ToolName,
} from '$lib/tools/tools.server'
import { logLlmUsage } from '$lib/costs/usage'
import { trimToolResult } from '$lib/chat/chat'
import { listSkillSummaries } from '$lib/skills/skills.server'

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
 * Creates a new conversation for the sub-agent, streams its work,
 * and returns the final result text.
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

	// Create a conversation for this sub-agent run
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

	let lastHeartbeatWriteAt = 0
	async function updateRun(patch: {
		state?: (typeof chatRuns.$inferInsert)['state']
		label?: string | null
		lastDelta?: string | null
		error?: string | null
		finished?: boolean
		heartbeat?: boolean
	}) {
		const now = Date.now()
		if (
			patch.heartbeat &&
			!patch.state &&
			patch.label === undefined &&
			patch.lastDelta === undefined &&
			patch.error === undefined &&
			now - lastHeartbeatWriteAt < 1000
		) {
			return
		}

		const values: Partial<typeof chatRuns.$inferInsert> = {
			updatedAt: new Date(now),
		}
		if (patch.state) values.state = patch.state
		if (patch.label !== undefined) values.label = patch.label
		if (patch.lastDelta !== undefined) values.lastDelta = patch.lastDelta
		if (patch.error !== undefined) values.error = patch.error
		if (patch.heartbeat || patch.state === 'running') values.lastHeartbeatAt = new Date(now)
		if (patch.finished) values.finishedAt = new Date(now)

		await db.update(chatRuns).set(values).where(eq(chatRuns.id, run.id))
		if (patch.heartbeat || patch.state === 'running') {
			lastHeartbeatWriteAt = now
		}
	}

	controller.enqueue(
		sse('subagent_start', {
			agentId: agent.id,
			agentName: agent.name,
			conversationId: subConversation.id,
			task: step.task,
		}),
	)

	// Save the task as the user message in sub-agent conversation
	await db.insert(messages).values({
		conversationId: subConversation.id,
		role: 'user',
		content: step.task,
		metadata: { source: 'orchestrator', parentConversationId },
	})

	// Build sub-agent context
	const systemSections = [agent.systemPrompt, `Your role: ${agent.role}`]
	systemSections.push(
		[
			'Agent collaboration policy:',
			'- You cannot ask the user directly with ask_user.',
			'- If you need user input, return a concise handoff for orchestrator with missing information and proposed options.',
			'- Once orchestrator returns answers in context, continue execution immediately.',
		].join('\n'),
	)

	const skillSummaries = await listSkillSummaries()
	if (skillSummaries.length > 0) {
		const text = skillSummaries
			.map((s) => {
				const fileNames = s.files.map((f) => f.name).join(', ')
				return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
			})
			.join('\n')
		systemSections.push(`Available skills (use read_skill to load):\n${text}`)
	}

	const subMessages: LlmMessage[] = [
		{ role: 'system', content: systemSections.join('\n\n') },
		{ role: 'user', content: step.task },
	]

	const tools = getToolDefinitions().filter((t) => t.function.name !== 'ask_user')
	const MAX_ROUNDS = 20
	let totalContent = ''
	let promptTokens = 0
	let completionTokens = 0

	try {
		for (let round = 0; round <= MAX_ROUNDS; round++) {
			const stream = await streamChat(subMessages, agent.model, tools)

			let roundContent = ''
			const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []

			for await (const chunk of stream) {
				const delta = chunk.choices?.[0]?.delta as
					| {
							content?: string
							toolCalls?: Array<{
								index?: number
								id?: string
								function?: { name?: string; arguments?: string }
							}>
					  }
					| undefined

				if (delta?.content) {
					roundContent += delta.content
					await updateRun({
						state: 'running',
						label: `Subagent ${agent.name} generating`,
						lastDelta: roundContent.slice(-500),
						heartbeat: true,
					})
					controller.enqueue(
						sse('subagent_delta', {
							agentId: agent.id,
							conversationId: subConversation.id,
							content: delta.content,
						}),
					)
				}

				const deltaToolCalls = delta?.toolCalls
				if (deltaToolCalls) {
					for (const tc of deltaToolCalls) {
						const idx = tc.index ?? 0
						if (!pendingToolCalls[idx]) {
							pendingToolCalls[idx] = { id: tc.id ?? '', name: '', arguments: '' }
						}
						if (tc.id) pendingToolCalls[idx].id = tc.id
						if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name
						if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments
					}
				}

				if (chunk.usage) {
					promptTokens += chunk.usage.promptTokens ?? 0
					completionTokens += chunk.usage.completionTokens ?? 0
				}
				await updateRun({ heartbeat: true })
			}

			totalContent += roundContent

			const validToolCalls = pendingToolCalls.filter((tc) => tc.name)
			if (validToolCalls.length === 0) break

			// Execute tool calls
			const toolResults: Array<{ call_id: string; name: string; result: string }> = []

			for (const tc of validToolCalls) {
				let parsedArgs: unknown = {}
				try {
					parsedArgs = JSON.parse(tc.arguments)
				} catch {
					parsedArgs = {}
				}

				if (tc.name === 'ask_user') {
					const parsed = toolSchemas.ask_user.safeParse(parsedArgs)
					const handoff = {
						requiresOrchestratorInput: true,
						reason: 'Subagents cannot call ask_user directly.',
						questions: parsed.success ? parsed.data.questions : [],
					}
					const resultStr = trimToolResult(tc.name, JSON.stringify(handoff))
					toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })

					controller.enqueue(
						sse('subagent_tool_result', {
							agentId: agent.id,
							conversationId: subConversation.id,
							name: tc.name,
							success: false,
							executionMs: 0,
						}),
					)
					continue
				}

				await updateRun({ state: 'running', label: `Subagent ${agent.name} executing ${tc.name}`, heartbeat: true })
				controller.enqueue(
					sse('subagent_tool_call', {
						agentId: agent.id,
						conversationId: subConversation.id,
						name: tc.name,
						arguments: tc.arguments,
					}),
				)

				const toolCall: ToolCallWithContext = {
					name: tc.name as ToolName,
					arguments: parsedArgs,
					conversationId: subConversation.id,
					messageId: null,
				}
				const toolResult = await executeTool(toolCall, userId)
				const rawResultStr = toolResult.success ? JSON.stringify(toolResult.result) : `Error: ${toolResult.error}`
				const resultStr = trimToolResult(tc.name, rawResultStr)

				toolResults.push({ call_id: tc.id, name: tc.name, result: resultStr })

				controller.enqueue(
					sse('subagent_tool_result', {
						agentId: agent.id,
						conversationId: subConversation.id,
						name: tc.name,
						success: toolResult.success,
						executionMs: toolResult.executionMs,
					}),
				)
			}

			// Append for next round
			subMessages.push({
				role: 'assistant',
				content: roundContent || '',
				toolCalls: validToolCalls.map((tc) => ({
					id: tc.id,
					type: 'function' as const,
					function: { name: tc.name, arguments: tc.arguments },
				})),
			})
			for (const tr of toolResults) {
				subMessages.push({
					role: 'tool',
					content: tr.result,
					toolCallId: tr.call_id,
				})
			}
		}

		// Save the sub-agent's response
		const cost = await logLlmUsage({
			source: 'subagent',
			model: agent.model,
			tokensIn: promptTokens,
			tokensOut: completionTokens,
			userId,
			runId: run.id,
			agentId: agent.id,
			metadata: {
				conversationId: subConversation.id,
				parentConversationId,
			},
		}).catch(() => '0')

		await db.insert(messages).values({
			conversationId: subConversation.id,
			role: 'assistant',
			content: totalContent || '(no output)',
			model: agent.model,
			tokensIn: promptTokens,
			tokensOut: completionTokens,
			cost,
		})

		await db
			.update(conversations)
			.set({
				totalTokens: promptTokens + completionTokens,
				totalCost: cost,
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, subConversation.id))

		await updateRun({
			state: 'completed',
			label: `Subagent ${agent.name} completed`,
			lastDelta: totalContent.slice(-500),
			heartbeat: true,
			finished: true,
		})

		controller.enqueue(
			sse('subagent_done', {
				agentId: agent.id,
				agentName: agent.name,
				conversationId: subConversation.id,
				resultPreview: totalContent.slice(0, 500),
			}),
		)

		return {
			result: totalContent,
			conversationId: subConversation.id,
			cost,
		}
	} catch (error) {
		await updateRun({
			state: 'failed',
			label: `Subagent ${agent.name} failed`,
			error: error instanceof Error ? error.message : 'Subagent execution failed',
			finished: true,
		})
		throw error
	}
}
