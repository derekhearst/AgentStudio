import type { ToolName } from '$lib/llm/tools'

/**
 * Capability groups that organize tools into logical bundles.
 * Only the groups detected as relevant are loaded per message,
 * reducing token usage and improving model focus.
 */
export const capabilityGroups = {
	core: {
		label: 'Core',
		description: 'Web search and memory lookup',
		tools: ['web_search', 'memory_search'] as ToolName[],
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
		tools: ['create_task', 'run_subagent'] as ToolName[],
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
