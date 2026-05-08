import { json, type RequestHandler } from '@sveltejs/kit'
import {
	executeTool,
	getToolDefinitions,
	toolSchemas,
	type ToolName,
} from '$lib/tools/tools.server'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { desc } from 'drizzle-orm'
import { getMcpApiKey } from '$lib/server/config'

const MCP_API_KEY = getMcpApiKey()

function verifyApiKey(request: Request): boolean {
	if (!MCP_API_KEY) return true // No key configured = open (dev mode)
	const auth = request.headers.get('Authorization')
	if (!auth) return false
	const token = auth.replace(/^Bearer\s+/i, '')
	return token === MCP_API_KEY
}

const SERVER_INFO = {
	name: 'AgentStudio',
	version: '1.0.0',
	protocolVersion: '2024-11-05',
	capabilities: {
		tools: { listChanged: false },
		resources: { subscribe: false, listChanged: false },
	},
}

/**
 * Expose every registered tool as an MCP tool. We re-use the canonical registry by calling
 * `getToolDefinitions(undefined, { tierFilter: false })` — that single call returns
 * `{type, function: {name, description, parameters}}` records derived from the same
 * `toolSchemas` + `toolDescriptions` the LLM loop uses, including JSON-schema parameters.
 *
 * MCP wants `{name, description, inputSchema}` so we just remap the shape.
 *
 * Previously this file kept its own ~350-line copy of descriptions and JSON-schema fragments
 * which silently drifted from `tool-schemas.ts` (e.g. `web_search` had a stale description and
 * the MCP map dropped half the optional parameters). Pulling from the registry kills the drift.
 */
function listTools() {
	return getToolDefinitions(undefined, { tierFilter: false }).map((def) => ({
		name: def.function.name,
		description: def.function.description,
		inputSchema: def.function.parameters,
	}))
}

function listResources() {
	return [
		{
			uri: 'AgentStudio://agents',
			name: 'Agents',
			description: 'Configured AI agents',
			mimeType: 'application/json',
		},
		{
			uri: 'AgentStudio://conversations',
			name: 'Conversations',
			description: 'Chat conversation history',
			mimeType: 'application/json',
		},
	]
}

async function readResource(uri: string) {
	if (uri === 'AgentStudio://agents') {
		const rows = await db.select().from(agents).orderBy(desc(agents.createdAt))
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'AgentStudio://conversations') {
		const rows = await db
			.select()
			.from(conversations)
			.orderBy(desc(conversations.createdAt))
			.limit(50)
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

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

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
						instructions: 'AgentStudio MCP server — exposes tools, agents, and conversations.',
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
				const result = await executeTool(
					{ name: name as ToolName, arguments: args },
					locals.user.id,
				)
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
		return json(
			rpcError(body.id, -32603, error instanceof Error ? error.message : 'Internal server error'),
		)
	}
}
