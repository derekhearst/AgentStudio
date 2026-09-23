import { command, query } from '$app/server'
import { z } from 'zod'
import { getOrCreateSettings, resetSettings, updateSettings } from '$lib/settings/settings.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { auditSettingsUpdated, recordAuditEvent } from '$lib/governance'
import { getSystemReadiness as readSystemReadiness } from '$lib/settings/readiness.server'
import { SPEECH_MODEL_ID_PATTERN, SPEECH_VOICE_PATTERN } from '$lib/speech/speech'
import { requireRunnableModelChange } from '$lib/engine/gateway.server'

const settingsUpdateSchema = z.object({
	defaultModel: z.string().trim().min(1).max(120).optional(),
	transcriptionModel: z.string().trim().min(1).max(120).optional(),
	ttsModel: z.string().trim().max(120).regex(SPEECH_MODEL_ID_PATTERN, 'Speech model must be an OpenRouter model id').optional(),
	// Empty is allowed: the speech model's own default voice.
	ttsVoice: z.string().trim().regex(SPEECH_VOICE_PATTERN, 'A voice name is up to 80 letters, digits, spaces and . _ : -').optional(),
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
	// The default model is what the engine runs a new conversation on (#9).
	const defaultModel = requireRunnableModelChange(input.defaultModel, before.defaultModel)
	const after = await updateSettings({ ...input, defaultModel, userId: user.id })
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

/**
 * Settings > System: which deploy-time settings (model credential, workspace, gateway,
 * integrations) are in place. Read-only — they are environment settings, not stored in the
 * database. Reports presence only, never a value.
 */
export const getSystemReadiness = query(async () => {
	requireAuthenticatedRequestUser()
	return readSystemReadiness()
})
