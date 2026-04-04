import { command, query } from '$app/server'
import { z } from 'zod'
import { getOrCreateSettings, resetSettings, updateSettings } from '$lib/server/settings/settings'

const settingsUpdateSchema = z.object({
	defaultModel: z.string().trim().min(1).max(120).optional(),
	theme: z.enum(['drokbot', 'drokbot-night']).optional(),
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
