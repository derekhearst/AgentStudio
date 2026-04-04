import { z } from 'zod'
import { webSearch } from '$lib/server/tools/search'
import { browserNavigate, browserScreenshot, execCode, execShell, readFile, writeFile } from '$lib/server/tools/sandbox'
import { searchMemories } from '$lib/server/memory/store'
import { createTaskForAvailableAgent, delegateTaskToAgent } from '$lib/server/agents/engine'
import { generateImage } from '$lib/server/tools/imagegen'

export const toolSchemas = {
	web_search: z.object({ query: z.string().min(1) }),
	code_execute: z.object({ code: z.string().min(1), language: z.string().default('typescript') }),
	file_read: z.object({ path: z.string().min(1) }),
	file_write: z.object({ path: z.string().min(1), content: z.string() }),
	browser_screenshot: z.object({ url: z.string().url().optional() }),
	memory_search: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
	create_task: z.object({ title: z.string().min(1), description: z.string().min(1) }),
	delegate_to_agent: z.object({ agentId: z.string().uuid(), task: z.string().min(1) }),
	image_generate: z.object({
		prompt: z.string().min(1).max(2000),
		model: z.enum(['flux', 'sdxl', 'dall-e']).default('flux'),
		size: z.enum(['256x256', '512x512', '1024x1024']).default('1024x1024'),
	}),
}

export type ToolName = keyof typeof toolSchemas

export type ToolCall = {
	name: ToolName
	arguments: unknown
}

export async function executeTool(call: ToolCall) {
	const startedAt = Date.now()
	try {
		if (call.name === 'web_search') {
			const input = toolSchemas.web_search.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await webSearch(input.query),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'code_execute') {
			const input = toolSchemas.code_execute.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await execCode(input.code, input.language),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_read') {
			const input = toolSchemas.file_read.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await readFile(input.path),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'file_write') {
			const input = toolSchemas.file_write.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await writeFile(input.path, input.content),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'browser_screenshot') {
			const input = toolSchemas.browser_screenshot.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await browserScreenshot(input.url),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'memory_search') {
			const input = toolSchemas.memory_search.parse(call.arguments)
			const matches = await searchMemories(input.query, input.limit)
			return {
				success: true,
				tool: call.name,
				input,
				result: matches,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'create_task') {
			const input = toolSchemas.create_task.parse(call.arguments)
			const task = await createTaskForAvailableAgent(input.title, input.description)
			return {
				success: true,
				tool: call.name,
				input,
				result: task,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'image_generate') {
			const input = toolSchemas.image_generate.parse(call.arguments)
			const result = await generateImage(input.prompt, input.model, input.size)
			return {
				success: true,
				tool: call.name,
				input,
				result,
				executionMs: Date.now() - startedAt,
			}
		}

		const input = toolSchemas.delegate_to_agent.parse(call.arguments)
		const delegated = await delegateTaskToAgent(input.agentId, input.task)
		return {
			success: true,
			tool: call.name,
			input,
			result: delegated,
			executionMs: Date.now() - startedAt,
		}
	} catch (error) {
		return {
			success: false,
			tool: call.name,
			error: error instanceof Error ? error.message : 'Tool execution failed',
			executionMs: Date.now() - startedAt,
		}
	}
}
