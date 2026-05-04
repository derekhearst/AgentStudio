type ToolName = string

/**
 * Capability groups that organize tools into logical bundles.
 * Only the groups detected as relevant are loaded per message,
 * reducing token usage and improving model focus.
 */
export const capabilityGroups = {
	core: {
		label: 'Core',
		description: 'Always-on essentials: web search, ask_user, list_automations, propose_plan, enable_capability meta-tool',
		tools: [
			'web_search',
			'ask_user',
			'list_automations',
			'propose_plan',
			'enable_capability',
		] as ToolName[],
		alwaysOn: true,
	},
	sandbox: {
		label: 'Coding Sandbox',
		description: 'Run shell commands, perform rich filesystem operations, browser screenshots, and read-only git introspection (worktree mode)',
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
			'git_status',
			'git_log',
			'git_diff',
		] as ToolName[],
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
	research: {
		label: 'Research',
		description: 'Read full web page content (web_fetch) for deeper investigation than web_search snippets allow',
		tools: ['web_fetch'] as ToolName[],
		alwaysOn: false,
	},
	projects: {
		label: 'Projects',
		description: 'Create and edit project artifacts (durable, version-tracked containers). Use list_projects + list_artifacts to find existing work, read_artifact + edit_artifact to revise, create_project + create_artifact to start fresh, set_project_context to bind a project to the conversation for sticky context.',
		tools: [
			'list_projects',
			'create_project',
			'list_artifacts',
			'read_artifact',
			'create_artifact',
			'edit_artifact',
			'set_project_context',
		] as ToolName[],
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
 * Token estimation. Uses js-tiktoken for known model families; falls back to chars/4 for unknown
 * models (and when the WASM-free encoder hasn't been initialized yet — first call is sync).
 *
 * Model family heuristic (based on the leading provider/model slug):
 *   - openai/* and o-series        → cl100k_base / o200k_base
 *   - anthropic/* (claude)         → cl100k_base (close-enough proxy until tiktoken ships claude)
 *   - google/* (gemini)            → cl100k_base proxy
 *   - everything else              → chars / 4 fallback
 *
 * Each encoder is lazily constructed and cached at module scope.
 */
import { encodingForModel, getEncoding, type Tiktoken, type TiktokenEncoding, type TiktokenModel } from 'js-tiktoken'

const FALLBACK_FACTOR = 4

const ENCODER_CACHE = new Map<TiktokenEncoding, Tiktoken>()
const MODEL_CACHE = new Map<TiktokenModel, Tiktoken>()
const FALLBACK_LOGGED = new Set<string>()

function getEncoder(name: TiktokenEncoding): Tiktoken | null {
	const cached = ENCODER_CACHE.get(name)
	if (cached) return cached
	try {
		const enc = getEncoding(name)
		ENCODER_CACHE.set(name, enc)
		return enc
	} catch {
		return null
	}
}

function getModelEncoder(name: TiktokenModel): Tiktoken | null {
	const cached = MODEL_CACHE.get(name)
	if (cached) return cached
	try {
		const enc = encodingForModel(name)
		MODEL_CACHE.set(name, enc)
		return enc
	} catch {
		return null
	}
}

/**
 * Pick an appropriate tiktoken encoder for a model slug. Returns null when no good match exists,
 * which causes `estimateTokensForModel` to fall back to chars/4.
 */
function encoderForModel(model: string): Tiktoken | null {
	const lower = model.toLowerCase()
	if (lower.startsWith('openai/') || lower.startsWith('o1') || lower.startsWith('gpt-')) {
		const slug = lower.replace(/^openai\//, '') as TiktokenModel
		const direct = getModelEncoder(slug)
		if (direct) return direct
		// gpt-4o family uses o200k_base
		if (slug.includes('4o') || slug.startsWith('o1') || slug.startsWith('o3')) return getEncoder('o200k_base')
		return getEncoder('cl100k_base')
	}
	// Anthropic, Google, Mistral, etc. don't have tiktoken encoders shipped — cl100k_base is a
	// reasonable proxy that's typically within ~10% of the real tokenizer for English text.
	return getEncoder('cl100k_base')
}

/**
 * Rough token estimate: chars / 4 fallback. Kept as a synchronous, model-agnostic helper for
 * places that don't know which model the text is destined for.
 */
export function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / FALLBACK_FACTOR)
}

/**
 * Model-aware token estimator. Uses tiktoken for known models, falls back to chars/4 otherwise.
 * Logs the fallback once per model so we know what's missing without spamming.
 */
export function estimateTokensForModel(text: string, model: string): number {
	if (!text) return 0
	const enc = encoderForModel(model)
	if (!enc) {
		if (!FALLBACK_LOGGED.has(model)) {
			FALLBACK_LOGGED.add(model)
			if (typeof console !== 'undefined') {
				console.warn(`[tokens] no tiktoken encoder for model "${model}"; using chars/4 fallback`)
			}
		}
		return estimateTokens(text)
	}
	try {
		return enc.encode(text).length
	} catch {
		return estimateTokens(text)
	}
}

/**
 * Estimate the token count of a tool definition (JSON schema).
 */
export function estimateToolDefinitionTokens(
	tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): number {
	return estimateTokens(JSON.stringify(tools))
}

export type BuiltinToolGroup = 'core' | 'sandbox' | 'skills' | 'agents' | 'media'

export type BuiltinTool = {
	name: string
	description: string
	group: BuiltinToolGroup
	groupLabel: string
}

const groupLabels: Record<BuiltinToolGroup, string> = {
	core: 'Core',
	sandbox: 'Coding Sandbox',
	skills: 'Skills',
	agents: 'Agents',
	media: 'Image Generation',
}

const toolDefinitions: Array<{ name: string; description: string; group: BuiltinToolGroup }> = [
	{ name: 'web_search', description: 'Search the web for information.', group: 'core' },
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
		name: 'git_status',
		description: 'Show git working-tree status (read-only). Worktree mode only.',
		group: 'sandbox',
	},
	{
		name: 'git_log',
		description: 'Show recent commits with author/date/subject (read-only). Worktree mode only.',
		group: 'sandbox',
	},
	{
		name: 'git_diff',
		description: 'Show diff vs HEAD or a ref, optionally staged or path-scoped (read-only). Worktree mode only.',
		group: 'sandbox',
	},
	{
		name: 'propose_plan',
		description: 'Propose a structured execution plan to the user with ordered steps, risks, and rollback. Required in plan mode.',
		group: 'core',
	},
	{
		name: 'enable_capability',
		description: 'Enable a capability group so its tools become available on the next round.',
		group: 'core',
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
