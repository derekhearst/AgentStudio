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
