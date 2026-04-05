import { command, query } from '$app/server'
import { z } from 'zod'
import { getOrCreateSettings, resetSettings, updateSettings } from '$lib/settings/settings'
import { getToolDefinitions, type ToolName } from '$lib/llm/tools'
import { listSkillSummaries } from '$lib/skills/store'
import { assembleContext } from '$lib/memory/context'
import {
	capabilityGroups,
	type CapabilityGroup,
	getActiveTools,
	buildCapabilityPrompt,
	estimateTokens,
	estimateToolDefinitionTokens,
} from '$lib/llm/capabilities'

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
		})
		.optional(),
	systemPrompt: z.string().max(12000).optional(),
})

export const getSettings = query(async () => {
	return getOrCreateSettings()
})

export const updateAppSettings = command(settingsUpdateSchema, async (input) => {
	return updateSettings(input)
})

export const resetAppSettings = command(async () => {
	return resetSettings()
})

export const getFullPromptPreview = query(async () => {
	const settings = await getOrCreateSettings()

	// --- Capability groups overview ---
	const allGroups = Object.entries(capabilityGroups) as [CapabilityGroup, (typeof capabilityGroups)[CapabilityGroup]][]
	const capabilityOverview = allGroups.map(([key, group]) => ({
		key,
		label: group.label,
		description: group.description,
		alwaysOn: group.alwaysOn,
		toolCount: group.tools.length,
		tools: [...group.tools],
	}))

	// --- Build two scenarios: minimal (core only) vs full (all groups active) ---
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

	const memoryContext = await assembleContext('sample conversation')
	const memoryPrompt = memoryContext.memories.length > 0 ? memoryContext.systemPrompt : undefined

	// Minimal scenario: only core tools, basic system prompt
	const minimalCapabilities: CapabilityGroup[] = ['core']
	const minimalSystemPrompt = buildCapabilityPrompt(minimalCapabilities, {
		customSystemPrompt: settings.systemPrompt || undefined,
	})
	const minimalToolNames = getActiveTools(minimalCapabilities)
	const minimalTools = getToolDefinitions(minimalToolNames)
	const minimalTokens = estimateTokens(minimalSystemPrompt) + estimateToolDefinitionTokens(minimalTools)

	// Full scenario: all groups active + memory + skills
	const fullCapabilities = Object.keys(capabilityGroups) as CapabilityGroup[]
	const fullSystemPrompt = buildCapabilityPrompt(fullCapabilities, {
		customSystemPrompt: settings.systemPrompt || undefined,
		skillSummaries: skillList,
	})
	const fullToolNames = getActiveTools(fullCapabilities)
	const fullTools = getToolDefinitions(fullToolNames)
	const fullTokens =
		estimateTokens(fullSystemPrompt) +
		estimateToolDefinitionTokens(fullTools) +
		(memoryPrompt ? estimateTokens(memoryPrompt) : 0)

	// --- Legacy-compatible systemMessages for display ---
	const systemMessages: Array<{ label: string; content: string; tokens: number }> = []

	const capPrompt = buildCapabilityPrompt(fullCapabilities, {
		customSystemPrompt: settings.systemPrompt || undefined,
		skillSummaries: skillList,
	})
	systemMessages.push({
		label: 'System Prompt (with all capabilities)',
		content: capPrompt,
		tokens: estimateTokens(capPrompt),
	})

	if (memoryPrompt) {
		systemMessages.push({
			label: 'Memory Context (sample)',
			content: memoryPrompt,
			tokens: estimateTokens(memoryPrompt),
		})
	}

	return {
		systemMessages,
		tools: fullTools,
		model: settings.defaultModel,
		toolApprovalMode: (settings.toolConfig as { approvalMode?: string } | undefined)?.approvalMode ?? 'auto',
		capabilityGroups: capabilityOverview,
		scenarios: {
			minimal: { tokens: minimalTokens, toolCount: minimalToolNames.length },
			full: { tokens: fullTokens, toolCount: fullToolNames.length },
		},
	}
})
