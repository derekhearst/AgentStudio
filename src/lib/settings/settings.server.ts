import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appSettings } from '$lib/settings/settings.schema'
import { DEFAULT_SETTINGS } from '$lib/settings/settings-defaults'

// The defaults live in their own module so a spec can read them without a database.
export { DEFAULT_SETTINGS } from '$lib/settings/settings-defaults'

export async function getOrCreateSettings(userId: string) {
	const [existing] = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.userId, userId))
		.orderBy(asc(appSettings.createdAt))
		.limit(1)
	if (existing) return existing

	const [created] = await db
		.insert(appSettings)
		.values({
			userId,
			defaultModel: DEFAULT_SETTINGS.defaultModel,
			transcriptionModel: DEFAULT_SETTINGS.transcriptionModel,
			// notificationPrefs: schema's column-default fills in dreamSummary for legacy
			// rows; we just don't expose it through this pipeline anymore.
			notificationPrefs: DEFAULT_SETTINGS.notificationPrefs,
			contextConfig: DEFAULT_SETTINGS.contextConfig,
			toolConfig: DEFAULT_SETTINGS.toolConfig,
			memoryConfig: DEFAULT_SETTINGS.memoryConfig,
			theme: DEFAULT_SETTINGS.theme,
			updatedAt: new Date(),
		})
		.returning()
	return created
}

export async function updateSettings(input: {
	userId: string
	defaultModel?: string
	transcriptionModel?: string
	theme?: string
	notificationPrefs?: {
		taskCompleted?: boolean
		needsInput?: boolean
		agentErrors?: boolean
	}
	budgetConfig?: {
		dailyLimit?: number | null
		monthlyLimit?: number | null
	}
	contextConfig?: {
		reservedResponsePct?: number
		autoCompactThresholdPct?: number
		preserveToolResults?: string[]
	}
	toolConfig?: {
		approvalRequiredTools?: string[]
		programmaticToolCallingEnabled?: boolean
	}
	memoryConfig?: {
		enabled?: boolean
		topK?: number
		useRerank?: boolean
		rerankModel?: string
		embeddingModel?: string
		autoMine?: boolean
	}
}) {
	const current = await getOrCreateSettings(input.userId)
	const currentToolConfig =
		(current.toolConfig as
			| {
					approvalRequiredTools?: string[]
					approvalMode?: 'auto' | 'confirm' | 'plan'
					disabledTools?: string[]
					programmaticToolCallingEnabled?: boolean
			  }
			| undefined) ?? {}

	const migratedApprovalRequiredTools = Array.isArray(currentToolConfig.approvalRequiredTools)
		? currentToolConfig.approvalRequiredTools
		: currentToolConfig.approvalMode === 'confirm'
			? ['*']
			: []
	const migratedProgrammaticToolCalling = currentToolConfig.programmaticToolCallingEnabled ?? false
	const [updated] = await db
		.update(appSettings)
		.set({
			defaultModel: input.defaultModel ?? current.defaultModel,
			transcriptionModel: input.transcriptionModel ?? current.transcriptionModel,
			theme: 'AgentStudio-night',
			notificationPrefs: {
				...current.notificationPrefs,
				...(input.notificationPrefs ?? {}),
			},
			budgetConfig: {
				...(current.budgetConfig ?? DEFAULT_SETTINGS.budgetConfig),
				...(input.budgetConfig ?? {}),
			},
			contextConfig: {
				...((current.contextConfig as typeof DEFAULT_SETTINGS.contextConfig | undefined) ??
					DEFAULT_SETTINGS.contextConfig),
				...(input.contextConfig ?? {}),
			},
			toolConfig: {
				approvalRequiredTools: migratedApprovalRequiredTools,
				programmaticToolCallingEnabled: migratedProgrammaticToolCalling,
				...(input.toolConfig ?? {}),
			},
			memoryConfig: {
				...((current.memoryConfig as typeof DEFAULT_SETTINGS.memoryConfig | undefined) ??
					DEFAULT_SETTINGS.memoryConfig),
				...(input.memoryConfig ?? {}),
			},
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, current.id))
		.returning()

	return updated
}

export async function resetSettings(userId: string) {
	const [existing] = await db
		.select()
		.from(appSettings)
		.where(eq(appSettings.userId, userId))
		.orderBy(asc(appSettings.createdAt))
		.limit(1)
	if (!existing) {
		return getOrCreateSettings(userId)
	}

	const [updated] = await db
		.update(appSettings)
		.set({
			// Every default, by spreading the one list of them. This used to name the fields
			// one by one and missed `transcriptionModel`, so Reset said "Settings reset to
			// defaults." and left the transcription model as it was.
			...DEFAULT_SETTINGS,
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, existing.id))
		.returning()
	return updated
}
