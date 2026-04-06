import { chat, type LlmMessage } from '$lib/llm/openrouter'
import { executeTool, type ToolCall, type ToolName } from '$lib/llm/tools'

type ToolResult = { success: boolean; tool: string; executionMs: number; [key: string]: unknown }

const SUBAGENT_MODEL = 'anthropic/claude-sonnet-4'
const MAX_TOOL_ROUNDS = 2

/**
 * Run a stateless subagent that processes a task and returns a result.
 * No persistence — no agent record, no task record, just execute and return.
 */
export async function runSubagent(task: string, context?: string) {
	const systemPrompt = [
		'You are a focused subagent. Complete the given task and return a clear, concise result.',
		'You have access to tools: web_search, shell, file_read, file_write, browser_screenshot, memory_search, image_generate.',
		'Use tools only when necessary. When done, provide your final answer as plain text.',
		'Return strict JSON: { "toolCalls": [...], "result": "your final answer" }',
		'Each toolCall: { "name": "tool_name", "arguments": { ... } }',
		'Max 3 tool calls per round.',
	].join('\n')

	const messages: LlmMessage[] = [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: context ? `Context: ${context}\n\nTask: ${task}` : `Task: ${task}`,
		},
	]

	const toolResults: Array<{ call: ToolCall; result: ToolResult }> = []

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const response = await chat(messages, SUBAGENT_MODEL)
		const parsed = parseSubagentResponse(response.content)

		if (parsed.toolCalls.length === 0) {
			return {
				result: parsed.result || response.content,
				toolResults,
				rounds: round + 1,
			}
		}

		for (const toolCall of parsed.toolCalls.slice(0, 3)) {
			const normalizedCall: ToolCall = {
				name: toolCall.name as ToolName,
				arguments: toolCall.arguments,
			}
			const result = await executeTool(normalizedCall)
			toolResults.push({ call: normalizedCall, result })
		}

		// Feed results back for next round
		messages.push({ role: 'assistant', content: response.content })
		messages.push({
			role: 'user',
			content: `Tool results:\n${JSON.stringify(
				toolResults.slice(-3).map((r) => ({
					name: r.call.name,
					success: r.result.success,
					result: r.result.success ? r.result.result : r.result.error,
				})),
			)}\n\nProvide your final answer or request more tools.`,
		})
	}

	// Final synthesis after tool rounds
	const finalResponse = await chat(messages, SUBAGENT_MODEL)

	return {
		result: finalResponse.content,
		toolResults,
		rounds: MAX_TOOL_ROUNDS,
	}
}

function parseSubagentResponse(content: string): {
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
	result: string
} {
	const start = content.indexOf('{')
	const end = content.lastIndexOf('}')
	if (start === -1 || end === -1 || end <= start) {
		return { toolCalls: [], result: content }
	}

	try {
		const json = JSON.parse(content.slice(start, end + 1))
		return {
			toolCalls: Array.isArray(json.toolCalls) ? json.toolCalls : [],
			result: json.result ?? '',
		}
	} catch {
		return { toolCalls: [], result: content }
	}
}
