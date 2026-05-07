import { command, query } from '$app/server'
import { z } from 'zod'
import { getOrCreateSettings, resetSettings, updateSettings } from '$lib/settings/settings.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { listSkillSummaries } from '$lib/skills/skills.server'
import { estimateTokens, estimateToolDefinitionTokens } from '$lib/tools/tools'
import { auditSettingsUpdated, recordAuditEvent } from '$lib/governance'

const settingsUpdateSchema = z.object({
	defaultModel: z.string().trim().min(1).max(120).optional(),
	transcriptionModel: z.string().trim().min(1).max(120).optional(),
	theme: z.enum(['AgentStudio-night']).optional(),
	notificationPrefs: z
		.object({
			taskCompleted: z.boolean().optional(),
			needsInput: z.boolean().optional(),
			agentErrors: z.boolean().optional(),
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
			preserveToolResults: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
		})
		.optional(),
	toolConfig: z
		.object({
			approvalRequiredTools: z.array(z.string()).optional(),
			programmaticToolCallingEnabled: z.boolean().optional(),
		})
		.optional(),
	memoryConfig: z
		.object({
			enabled: z.boolean().optional(),
			topK: z.number().int().min(1).max(20).optional(),
			useRerank: z.boolean().optional(),
			rerankModel: z.string().trim().min(1).max(120).optional(),
			embeddingModel: z.string().trim().min(1).max(120).optional(),
			autoMine: z.boolean().optional(),
		})
		.optional(),
	systemPrompt: z.string().max(12000).optional(),
})

const approvalRequiredToolsSchema = z.object({
	approvalRequiredTools: z.array(z.string()),
})

export const getSettings = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return getOrCreateSettings(user.id)
})

export const updateAppSettings = command(settingsUpdateSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const before = await getOrCreateSettings(user.id)
	const after = await updateSettings({ ...input, userId: user.id })
	void auditSettingsUpdated({
		actorUserId: user.id,
		beforeState: before as Record<string, unknown>,
		afterState: after as Record<string, unknown>,
	})
	return after
})

export const updateApprovalRequiredToolsCommand = command(
	approvalRequiredToolsSchema,
	async ({ approvalRequiredTools }) => {
		const user = requireAuthenticatedRequestUser()
		const before = await getOrCreateSettings(user.id)
		const after = await updateSettings({ userId: user.id, toolConfig: { approvalRequiredTools } })
		void auditSettingsUpdated({
			actorUserId: user.id,
			beforeState: before as Record<string, unknown>,
			afterState: after as Record<string, unknown>,
		})
		return after
	},
)

export const resetAppSettings = command(async () => {
	const user = requireAuthenticatedRequestUser()
	const before = await getOrCreateSettings(user.id)
	const after = await resetSettings(user.id)
	void recordAuditEvent({
		actorUserId: user.id,
		action: 'settings.reset',
		targetType: 'settings',
		targetId: user.id,
		beforeState: before as Record<string, unknown>,
		afterState: after as Record<string, unknown>,
		summary: 'Settings reset to defaults',
	})
	return after
})

export const getFullPromptPreview = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const settings = await getOrCreateSettings(user.id)

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

	function buildScenario(label: string) {
		const sections: string[] = []
		if (settings.systemPrompt?.trim()) sections.push(settings.systemPrompt)
		if (skillList) sections.push(`Available skills (use read_skill to load full content when relevant):\n${skillList}`)
		const systemPrompt = sections.join('\n\n')

		const tools = getToolDefinitions()
		const toolsJson = JSON.stringify(tools, null, 2)

		const rawParts: Array<{ label: string; content: string }> = []
		rawParts.push({ label: 'System Message', content: systemPrompt })
		rawParts.push({ label: `Tools (${tools.length})`, content: toolsJson })

		const totalChars = systemPrompt.length + toolsJson.length
		const estimatedTokens = estimateTokens(systemPrompt) + estimateToolDefinitionTokens(tools)

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
		approvalRequiredTools:
			(settings.toolConfig as { approvalRequiredTools?: string[] } | undefined)?.approvalRequiredTools ?? [],
		scenarios: {
			simple: buildScenario('Simple Query'),
			complex: buildScenario('Complex Query'),
		},
	}
})
