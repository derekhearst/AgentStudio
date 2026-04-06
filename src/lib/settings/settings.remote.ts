import { command, query } from '$app/server'
import { z } from 'zod'
import { getOrCreateSettings, resetSettings, updateSettings } from '$lib/settings/settings'
import { getToolDefinitions } from '$lib/llm/tools'
import { listSkillSummaries } from '$lib/skills/store'
import { assembleContext } from '$lib/memory/context'
import { capabilityGroups, estimateTokens, estimateToolDefinitionTokens } from '$lib/llm/capabilities'

const settingsUpdateSchema = z.object({
	defaultModel: z.string().trim().min(1).max(120).optional(),
	transcriptionModel: z.string().trim().min(1).max(120).optional(),
	theme: z.enum(['drokbot-night']).optional(),
	notificationPrefs: z
		.object({
			taskCompleted: z.boolean().optional(),
			needsInput: z.boolean().optional(),
			dreamSummary: z.boolean().optional(),
			agentErrors: z.boolean().optional(),
		})
		.optional(),
	dreamConfig: z
		.object({
			autoRun: z.boolean().optional(),
			frequencyHours: z
				.number()
				.int()
				.min(1)
				.max(24 * 30)
				.optional(),
			aggressiveness: z.number().min(0).max(1).optional(),
		})
		.optional(),
	budgetConfig: z
		.object({
			dailyLimit: z.number().min(0).nullable().optional(),
			monthlyLimit: z.number().min(0).nullable().optional(),
		})
		.optional(),
	contextConfig: z
		.object({
			reservedResponsePct: z.number().min(10).max(40).optional(),
			autoCompactThresholdPct: z.number().min(40).max(95).optional(),
			compactionModel: z.string().trim().min(1).max(120).optional(),
		})
		.optional(),
	toolConfig: z
		.object({
			approvalMode: z.enum(['auto', 'confirm']).optional(),
			disabledTools: z.array(z.string()).optional(),
		})
		.optional(),
	systemPrompt: z.string().max(12000).optional(),
})

const disabledToolsSchema = z.object({
	disabledTools: z.array(z.string()),
})

export const getSettings = query(async () => {
	return getOrCreateSettings()
})

export const updateAppSettings = command(settingsUpdateSchema, async (input) => {
	return updateSettings(input)
})

export const updateDisabledToolsCommand = command(disabledToolsSchema, async ({ disabledTools }) => {
	return updateSettings({ toolConfig: { disabledTools } })
})

export const resetAppSettings = command(async () => {
	return resetSettings()
})

export const getFullPromptPreview = query(async () => {
	const settings = await getOrCreateSettings()

	// Skill summaries
	const skillSummaries = await listSkillSummaries()
	const skillList =
		skillSummaries.length > 0
			? skillSummaries
					.map((s) => {
						const fileNames = s.files.map((f: { name: string }) => f.name).join(', ')
						return `- ${s.name}: ${s.description}${fileNames ? ` [files: ${fileNames}]` : ''}`
					})
					.join('\n')
			: undefined

	// Memory context sample
	const memoryContext = await assembleContext('sample conversation')
	const memoryPrompt = memoryContext.memories.length > 0 ? memoryContext.systemPrompt : undefined

	function buildScenario(label: string) {
		const sections: string[] = []
		if (settings.systemPrompt?.trim()) sections.push(settings.systemPrompt)
		if (skillList) sections.push(`Available skills (use read_skill to load full content when relevant):\n${skillList}`)
		const systemPrompt = sections.join('\n\n')

		const disabledTools = new Set(
			(settings.toolConfig as { disabledTools?: string[] } | undefined)?.disabledTools ?? [],
		)
		const tools = getToolDefinitions().filter((tool) => !disabledTools.has(tool.function.name))
		const toolsJson = JSON.stringify(tools, null, 2)

		const rawParts: Array<{ label: string; content: string }> = []
		rawParts.push({ label: 'System Message', content: systemPrompt })
		if (memoryPrompt) {
			rawParts.push({ label: 'Memory Context', content: memoryPrompt })
		}
		rawParts.push({ label: `Tools (${tools.length})`, content: toolsJson })

		const totalChars = systemPrompt.length + (memoryPrompt?.length ?? 0) + toolsJson.length
		const estimatedTokens =
			estimateTokens(systemPrompt) +
			estimateToolDefinitionTokens(tools) +
			(memoryPrompt ? estimateTokens(memoryPrompt) : 0)

		return {
			label,
			capabilities: [] as string[],
			toolCount: tools.length,
			estimatedTokens,
			totalChars,
			parts: rawParts,
		}
	}

	return {
		model: settings.defaultModel,
		availableCapabilityGroups: Object.entries(capabilityGroups).map(([key, group]) => ({ key, label: group.label })),
		toolApprovalMode: (settings.toolConfig as { approvalMode?: string } | undefined)?.approvalMode ?? 'auto',
		scenarios: {
			simple: buildScenario('Simple Query'),
			complex: buildScenario('Complex Query'),
		},
	}
})
