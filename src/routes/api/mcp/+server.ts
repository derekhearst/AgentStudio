import { json, type RequestHandler } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { executeTool, toolSchemas, type ToolName } from '$lib/tools/tools.server'
import { searchMemories } from '$lib/memory/memory.server'
import { db } from '$lib/db.server'
import { agents, agentTasks } from '$lib/agents/agents.schema'
import { conversations } from '$lib/chat/chat.schema'
import { memories } from '$lib/memory/memory.schema'
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
	name: 'AGENTSTUDIO',
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
	shell: 'Run a shell command in a sandboxed environment',
	file_read: 'Read a file from the sandbox filesystem, optionally by line range',
	file_write: 'Write a file to the sandbox filesystem',
	file_patch: 'Apply a unified diff patch to files in the sandbox workspace',
	file_replace: 'Replace an exact string in a file with deterministic unique-match behavior by default',
	list_directory: 'List files and directories with optional depth and hidden-file controls',
	delete_file: 'Delete a file or directory (recursive=true required for directories)',
	move_file: 'Move or rename a file/directory',
	search_files: 'Search file contents with ripgrep-style matching and options',
	file_info: 'Return metadata for a file or directory',
	browser_screenshot: 'Take a screenshot of a web page',
	memory_search: 'Search through stored memories using semantic similarity',
	create_task: 'Create a new task for an available agent',
	run_subagent: 'Run a general-purpose stateless subagent to handle a task',
	image_generate: 'Generate an image from a text prompt',
	artifact_create: 'Create a persistent artifact (document, code, config, diagram, etc.)',
	artifact_update: 'Update the content of an existing artifact. Creates a new version automatically.',
	artifact_storage_update: "Update a key in an artifact's persistent storage.",
	list_skills: 'List all available skills with their names and descriptions.',
	read_skill: 'Read a skill by name. Returns main content and available nested files.',
	read_skill_file: 'Read a specific nested file within a skill.',
	create_skill: 'Create a new skill with a name, description, and main content.',
	update_skill: 'Update an existing skill by name.',
	add_skill_file: 'Add a nested file to an existing skill.',
	update_skill_file: 'Update a nested file within a skill.',
	delete_skill: 'Delete a skill and all its nested files.',
	delete_skill_file: 'Delete a specific nested file from a skill.',
}

function schemaToJsonSchema(name: ToolName) {
	const schemas: Record<string, object> = {
		web_search: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
		shell: {
			type: 'object',
			properties: { command: { type: 'string' } },
			required: ['command'],
		},
		file_read: {
			type: 'object',
			properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } },
			required: ['path'],
		},
		file_write: {
			type: 'object',
			properties: { path: { type: 'string' }, content: { type: 'string' } },
			required: ['path', 'content'],
		},
		file_patch: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
		file_replace: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				oldStr: { type: 'string' },
				newStr: { type: 'string' },
				requireUnique: { type: 'boolean', default: true },
				replaceAll: { type: 'boolean', default: false },
			},
			required: ['path', 'oldStr', 'newStr'],
		},
		list_directory: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				depth: { type: 'number', default: 1 },
				includeHidden: { type: 'boolean', default: false },
			},
		},
		delete_file: {
			type: 'object',
			properties: { path: { type: 'string' }, recursive: { type: 'boolean', default: false } },
			required: ['path'],
		},
		move_file: {
			type: 'object',
			properties: {
				fromPath: { type: 'string' },
				toPath: { type: 'string' },
				overwrite: { type: 'boolean', default: false },
			},
			required: ['fromPath', 'toPath'],
		},
		search_files: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				path: { type: 'string' },
				maxResults: { type: 'number', default: 50 },
				isRegex: { type: 'boolean', default: false },
				includeIgnored: { type: 'boolean', default: false },
				caseSensitive: { type: 'boolean', default: false },
			},
			required: ['query'],
		},
		file_info: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
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
		run_subagent: {
			type: 'object',
			properties: { task: { type: 'string' }, context: { type: 'string' } },
			required: ['task'],
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
		artifact_create: {
			type: 'object',
			properties: {
				type: {
					type: 'string',
					enum: [
						'document',
						'code',
						'config',
						'image',
						'svg',
						'html',
						'diagram',
						'data_table',
						'audio',
						'video',
						'mermaid',
						'svelte',
					],
				},
				title: { type: 'string' },
				content: { type: 'string' },
				language: { type: 'string' },
				category: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['type', 'title', 'content'],
		},
		artifact_update: {
			type: 'object',
			properties: {
				artifactId: { type: 'string' },
				content: { type: 'string' },
				title: { type: 'string' },
				language: { type: 'string' },
			},
			required: ['artifactId', 'content'],
		},
		artifact_storage_update: {
			type: 'object',
			properties: {
				artifactId: { type: 'string' },
				key: { type: 'string' },
				value: {},
			},
			required: ['artifactId', 'key', 'value'],
		},
		list_skills: { type: 'object', properties: {} },
		read_skill: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
		read_skill_file: {
			type: 'object',
			properties: { skillName: { type: 'string' }, fileName: { type: 'string' } },
			required: ['skillName', 'fileName'],
		},
		create_skill: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				description: { type: 'string' },
				content: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['name', 'description', 'content'],
		},
		update_skill: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				description: { type: 'string' },
				content: { type: 'string' },
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['name'],
		},
		add_skill_file: {
			type: 'object',
			properties: {
				skillName: { type: 'string' },
				fileName: { type: 'string' },
				description: { type: 'string' },
				content: { type: 'string' },
			},
			required: ['skillName', 'fileName', 'content'],
		},
		update_skill_file: {
			type: 'object',
			properties: {
				skillName: { type: 'string' },
				fileName: { type: 'string' },
				content: { type: 'string' },
				description: { type: 'string' },
			},
			required: ['skillName', 'fileName'],
		},
		delete_skill: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
		delete_skill_file: {
			type: 'object',
			properties: { skillName: { type: 'string' }, fileName: { type: 'string' } },
			required: ['skillName', 'fileName'],
		},
	}
	return schemas[name] ?? { type: 'object' }
}

// MCP Resources
function listResources() {
	return [
		{
			uri: 'AGENTSTUDIO://memories',
			name: 'Memories',
			description: 'Stored knowledge and facts',
			mimeType: 'application/json',
		},
		{ uri: 'AGENTSTUDIO://agents', name: 'Agents', description: 'Configured AI agents', mimeType: 'application/json' },
		{ uri: 'AGENTSTUDIO://tasks', name: 'Tasks', description: 'Agent task queue', mimeType: 'application/json' },
		{
			uri: 'AGENTSTUDIO://conversations',
			name: 'Conversations',
			description: 'Chat conversation history',
			mimeType: 'application/json',
		},
	]
}

async function readResource(uri: string) {
	if (uri === 'AGENTSTUDIO://memories') {
		const rows = await db.select().from(memories).orderBy(desc(memories.createdAt)).limit(100)
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'AGENTSTUDIO://agents') {
		const rows = await db.select().from(agents).orderBy(desc(agents.createdAt))
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'AGENTSTUDIO://tasks') {
		const rows = await db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(100)
		return [{ uri, mimeType: 'application/json', text: JSON.stringify(rows) }]
	}
	if (uri === 'AGENTSTUDIO://conversations') {
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
						instructions: 'AGENTSTUDIO MCP server — exposes tools, memories, agents, tasks, and conversations.',
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
				const result = await executeTool({ name: name as ToolName, arguments: args }, locals.user.id)
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


