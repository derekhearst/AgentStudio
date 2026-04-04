import { json, type RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { executeTool, toolSchemas, type ToolName } from '$lib/server/llm/tools'
import { searchMemories } from '$lib/server/memory/store'
import { db } from '$lib/server/db'
import { agents, agentTasks, conversations, memories } from '$lib/server/db/schema'
import { desc, eq } from 'drizzle-orm'

const MCP_API_KEY = env.MCP_API_KEY

function verifyApiKey(request: Request): boolean {
	if (!MCP_API_KEY) return true // No key configured = open (dev mode)
	const auth = request.headers.get('Authorization')
	if (!auth) return false
	const token = auth.replace(/^Bearer\s+/i, '')
	return token === MCP_API_KEY
}

// MCP Server Info
const SERVER_INFO = {
	name: 'drokbot',
	version: '1.0.0',
	protocolVersion: '2024-11-05',
	capabilities: {
		tools: { listChanged: false },
		resources: { subscribe: false, listChanged: false },
	},
}

// Expose agent tools as MCP tools
function listTools() {
	return Object.entries(toolSchemas).map(([name, schema]) => ({
		name,
		description: toolDescriptions[name as ToolName] ?? name,
		inputSchema: schemaToJsonSchema(name as ToolName),
	}))
}

const toolDescriptions: Record<ToolName, string> = {
	web_search: 'Search the web using SearXNG',
	code_execute: 'Execute code in a sandboxed environment',
	file_read: 'Read a file from the sandbox filesystem',
	file_write: 'Write a file to the sandbox filesystem',
	browser_screenshot: 'Take a screenshot of a web page',
	memory_search: 'Search through stored memories using semantic similarity',
	create_task: 'Create a new task for an available agent',
	delegate_to_agent: 'Delegate a task to a specific agent',
	image_generate: 'Generate an image from a text prompt',
}

function schemaToJsonSchema(name: ToolName) {
	const schemas: Record<string, object> = {
		web_search: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		code_execute: {
			type: 'object',
			properties: { code: { type: 'string' }, language: { type: 'string', default: 'typescript' } },
			required: ['code'],
		},
		file_read: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
		file_write: {
			type: 'object',
			properties: { path: { type: 'string' }, content: { type: 'string' } },
			required: ['path', 'content'],
		},
		browser_screenshot: { type: 'object', properties: { url: { type: 'string' } } },
		memory_search: {
			type: 'object',
			properties: { query: { type: 'string' }, limit: { type: 'number', default: 5 } },
			required: ['query'],
		},
		create_task: {
			type: 'object',
			properties: { title: { type: 'string' }, description: { type: 'string' } },
			required: ['title', 'description'],
		},
		delegate_to_agent: {
			type: 'object',
			properties: { agentId: { type: 'string' }, task: { type: 'string' } },
			required: ['agentId', 'task'],
		},
		image_generate: {
			type: 'object',
			properties: {
				prompt: { type: 'string' },
				model: { type: 'string', enum: ['flux', 'sdxl', 'dall-e'], default: 'flux' },
				size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'], default: '1024x1024' },
			},
			required: ['prompt'],
		},
	}
	return schemas[name] ?? { type: 'object' }
}

// MCP Resources
function listResources() {
	return [
		{
			uri: 'drokbot://memories',
			name: 'Memories',
			description: 'Stored knowledge and facts',
			mimeType: 'application/json',
		},
		{ uri: 'drokbot://agents', name: 'Agents', description: 'Configured AI agents', mimeType: 'application/json' },
		{ uri: 'drokbot://tasks', name: 'Tasks', description: 'Agent task queue', mimeType: 'application/json' },
		{
			uri: 'drokbot://conversations',
			name: 'Conversations',
			description: 'Chat conversation history',
			mimeType: 'application/json',
		},
	]
}

async function readResource(uri: string) {
	if (uri === 'drokbot://memories') {
		const rows = await db.select().from(memories).orderBy(desc(memories.createdAt)).limit(100)
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'drokbot://agents') {
		const rows = await db.select().from(agents).orderBy(desc(agents.createdAt))
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'drokbot://tasks') {
		const rows = await db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(100)
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'drokbot://conversations') {
		const rows = await db.select().from(conversations).orderBy(desc(conversations.createdAt)).limit(50)
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	throw new Error(`Unknown resource: ${uri}`)
}

// JSON-RPC handler
type JsonRpcRequest = {
	jsonrpc: '2.0'
	id: string | number
	method: string
	params?: Record<string, unknown>
}

function rpcResponse(id: string | number, result: unknown) {
	return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number, code: number, message: string) {
	return { jsonrpc: '2.0', id, error: { code, message } }
}

export const POST: RequestHandler = async ({ request }) => {
	if (!verifyApiKey(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const body = (await request.json()) as JsonRpcRequest

	if (body.jsonrpc !== '2.0' || !body.method) {
		return json(rpcError(body.id ?? 0, -32600, 'Invalid JSON-RPC request'))
	}

	try {
		switch (body.method) {
			case 'initialize':
				return json(
					rpcResponse(body.id, {
						...SERVER_INFO,
						instructions: 'DrokBot MCP server — exposes tools, memories, agents, tasks, and conversations.',
					}),
				)

			case 'tools/list':
				return json(rpcResponse(body.id, { tools: listTools() }))

			case 'tools/call': {
				const name = (body.params?.name as string) ?? ''
				const args = (body.params?.arguments as Record<string, unknown>) ?? {}
				if (!Object.keys(toolSchemas).includes(name)) {
					return json(rpcError(body.id, -32602, `Unknown tool: ${name}`))
				}
				const result = await executeTool({ name: name as ToolName, arguments: args })
				if (result.success) {
					return json(
						rpcResponse(body.id, {
							content: [{ type: 'text', text: JSON.stringify(result.result) }],
						}),
					)
				}
				return json(
					rpcResponse(body.id, {
						content: [{ type: 'text', text: `Error: ${result.error}` }],
						isError: true,
					}),
				)
			}

			case 'resources/list':
				return json(rpcResponse(body.id, { resources: listResources() }))

			case 'resources/read': {
				const uri = (body.params?.uri as string) ?? ''
				const contents = await readResource(uri)
				return json(rpcResponse(body.id, { contents }))
			}

			case 'ping':
				return json(rpcResponse(body.id, {}))

			default:
				return json(rpcError(body.id, -32601, `Method not found: ${body.method}`))
		}
	} catch (error) {
		return json(rpcError(body.id, -32603, error instanceof Error ? error.message : 'Internal server error'))
	}
}
