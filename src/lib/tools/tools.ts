type ToolName = string

/**
 * Capability groups that organize tools into logical bundles.
 * Only the groups detected as relevant are loaded per message,
 * reducing token usage and improving model focus.
 */
export const capabilityGroups = {
	core: {
		label: 'Core',
		description: 'Web search and memory lookup',
		tools: ['web_search', 'memory_search', 'ask_user', 'list_automations'] as ToolName[],
		alwaysOn: true,
	},
	sandbox: {
		label: 'Coding Sandbox',
		description: 'Run shell commands and perform rich filesystem operations, plus browser screenshots',
		tools: [
			'shell',
			'file_read',
			'file_write',
			'file_patch',
			'file_replace',
			'list_directory',
			'delete_file',
			'move_file',
			'search_files',
			'file_info',
			'browser_screenshot',
		] as ToolName[],
		alwaysOn: false,
	},
	artifacts: {
		label: 'Artifacts',
		description: 'Create and update persistent versioned documents, code, diagrams, and more',
		tools: ['artifact_create', 'artifact_update', 'artifact_storage_update'] as ToolName[],
		alwaysOn: false,
	},
	skills: {
		label: 'Skills',
		description: 'Browse, read, create, and manage reusable skill/knowledge bundles',
		tools: [
			'list_skills',
			'read_skill',
			'read_skill_file',
			'create_skill',
			'update_skill',
			'add_skill_file',
			'update_skill_file',
			'delete_skill',
			'delete_skill_file',
		] as ToolName[],
		alwaysOn: false,
	},
	agents: {
		label: 'Agents',
		description: 'Create tasks and run sub-agents for delegation',
		tools: [
			'create_task',
			'run_subagent',
			'update_agent',
			'pause_agent',
			'resume_agent',
			'create_user',
			'create_automation',
			'update_automation',
			'delete_automation',
		] as ToolName[],
		alwaysOn: false,
	},
	media: {
		label: 'Image Generation',
		description: 'Generate images from text prompts',
		tools: ['image_generate'] as ToolName[],
		alwaysOn: false,
	},
} as const satisfies Record<string, { label: string; description: string; tools: ToolName[]; alwaysOn: boolean }>

export type CapabilityGroup = keyof typeof capabilityGroups

// Reverse lookup: tool name → group
const toolToGroup: Record<string, CapabilityGroup> = {}
for (const [groupName, group] of Object.entries(capabilityGroups)) {
	for (const tool of group.tools) {
		toolToGroup[tool] = groupName as CapabilityGroup
	}
}

export function getGroupForTool(toolName: string): CapabilityGroup | undefined {
	return toolToGroup[toolName]
}

/**
 * Model context window sizes (in tokens) for compaction calculations.
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'anthropic/claude-sonnet-4': 200_000,
	'anthropic/claude-opus-4': 200_000,
	'openai/gpt-4o-mini': 128_000,
}

export function getContextWindowSize(model: string): number {
	return MODEL_CONTEXT_WINDOWS[model] ?? 200_000
}

/**
 * Rough token estimate: ~4 chars per token.
 */
export function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / 4)
}

/**
 * Estimate the token count of a tool definition (JSON schema).
 */
export function estimateToolDefinitionTokens(
	tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): number {
	return estimateTokens(JSON.stringify(tools))
}

export type BuiltinToolGroup = 'core' | 'sandbox' | 'artifacts' | 'skills' | 'agents' | 'media'

export type BuiltinTool = {
	name: string
	description: string
	group: BuiltinToolGroup
	groupLabel: string
}

const groupLabels: Record<BuiltinToolGroup, string> = {
	core: 'Core',
	sandbox: 'Coding Sandbox',
	artifacts: 'Artifacts',
	skills: 'Skills',
	agents: 'Agents',
	media: 'Image Generation',
}

const toolDefinitions: Array<{ name: string; description: string; group: BuiltinToolGroup }> = [
	{ name: 'web_search', description: 'Search the web for information.', group: 'core' },
	{ name: 'memory_search', description: 'Search persistent memory for relevant information.', group: 'core' },
	{
		name: 'ask_user',
		description: 'Ask the user one or more clarifying questions with predefined answer options.',
		group: 'core',
	},
	{ name: 'list_automations', description: 'List automations for the current user.', group: 'core' },
	{ name: 'shell', description: 'Run a shell command in the sandboxed environment.', group: 'sandbox' },
	{
		name: 'file_read',
		description: 'Read a file from the sandbox filesystem, optionally by line range.',
		group: 'sandbox',
	},
	{ name: 'file_write', description: 'Write content to a file in the sandbox filesystem.', group: 'sandbox' },
	{
		name: 'file_patch',
		description: 'Apply a unified diff patch to files in the sandbox workspace.',
		group: 'sandbox',
	},
	{
		name: 'file_replace',
		description:
			'Replace an exact string in a file. By default requires exactly one match, making edits deterministic and retry-safe.',
		group: 'sandbox',
	},
	{
		name: 'list_directory',
		description: 'List files and directories with depth and hidden-file controls.',
		group: 'sandbox',
	},
	{
		name: 'delete_file',
		description: 'Delete a file or directory (recursive deletes require explicit recursive=true).',
		group: 'sandbox',
	},
	{ name: 'move_file', description: 'Move or rename a file/directory within the sandbox workspace.', group: 'sandbox' },
	{
		name: 'search_files',
		description: 'Search file contents in the workspace (ripgrep-style) with optional regex and ignore controls.',
		group: 'sandbox',
	},
	{
		name: 'file_info',
		description: 'Get file or directory metadata (size, modified time, permissions).',
		group: 'sandbox',
	},
	{ name: 'browser_screenshot', description: 'Take a screenshot of a web page.', group: 'sandbox' },
	{
		name: 'artifact_create',
		description:
			'Create a persistent artifact (document, code, config, diagram, etc.). Use for code snippets over 15 lines, full documents, configs, diagrams, data tables, HTML pages, and Svelte components.',
		group: 'artifacts',
	},
	{
		name: 'artifact_update',
		description: 'Update the content of an existing artifact. Creates a new version automatically.',
		group: 'artifacts',
	},
	{
		name: 'artifact_storage_update',
		description:
			"Update a key in an artifact's persistent storage. Used for reactive/living artifacts like trackers and dashboards.",
		group: 'artifacts',
	},
	{
		name: 'list_skills',
		description:
			'List all available skills with their names, descriptions, and nested file names. Use this to discover what skills are available.',
		group: 'skills',
	},
	{
		name: 'read_skill',
		description:
			'Read a skill by name. Returns the main content and a list of available nested files. Use this when a skill is relevant to the current task.',
		group: 'skills',
	},
	{
		name: 'read_skill_file',
		description: 'Read a specific nested file within a skill. Use after read_skill to load additional context files.',
		group: 'skills',
	},
	{
		name: 'create_skill',
		description:
			'Create a new skill with a name, description, and main content. Skills are reusable instruction/knowledge bundles. Keep main content under 8KB.',
		group: 'skills',
	},
	{
		name: 'update_skill',
		description: 'Update an existing skill by name. Can modify description, content, or tags.',
		group: 'skills',
	},
	{
		name: 'add_skill_file',
		description:
			'Add a nested file to an existing skill. Files provide optional additional context (e.g., examples, sub-topics).',
		group: 'skills',
	},
	{
		name: 'update_skill_file',
		description: 'Update a nested file within a skill by skill name and file name.',
		group: 'skills',
	},
	{ name: 'delete_skill', description: 'Delete a skill and all its nested files by name.', group: 'skills' },
	{ name: 'delete_skill_file', description: 'Delete a specific nested file from a skill.', group: 'skills' },
	{ name: 'create_task', description: 'Create a new agent task.', group: 'agents' },
	{
		name: 'run_subagent',
		description:
			'Run a general-purpose subagent to handle a task. The subagent is stateless and returns a result without persistence.',
		group: 'agents',
	},
	{ name: 'update_agent', description: 'Update an existing agent.', group: 'agents' },
	{ name: 'pause_agent', description: 'Pause an existing agent.', group: 'agents' },
	{ name: 'resume_agent', description: 'Resume an existing agent.', group: 'agents' },
	{ name: 'create_user', description: 'Create a user account (admin only).', group: 'agents' },
	{ name: 'create_automation', description: 'Create a recurring automation.', group: 'agents' },
	{ name: 'update_automation', description: 'Update a recurring automation.', group: 'agents' },
	{ name: 'delete_automation', description: 'Delete a recurring automation.', group: 'agents' },
	{ name: 'image_generate', description: 'Generate an image from a text prompt.', group: 'media' },
]

export const BUILTIN_TOOLS: BuiltinTool[] = toolDefinitions
	.map((tool) => ({
		...tool,
		groupLabel: groupLabels[tool.group],
	}))
	.sort((a, b) => {
		if (a.group !== b.group) return a.group.localeCompare(b.group)
		return a.name.localeCompare(b.name)
	})
