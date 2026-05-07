import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appSettings } from '$lib/settings/settings.schema'

/**
 * Note on `dreamConfig` + `notificationPrefs.dreamSummary`:
 * Both fields are deprecated — the spec calls dream-run config out as removed
 * (background memory work moved into the memory domain). The DB columns stay
 * for migration compatibility but the application no longer reads or writes
 * them. A future destructive migration can drop them once we're confident no
 * downstream consumer references them.
 */
export const DEFAULT_SETTINGS = {
	defaultModel: 'anthropic/claude-sonnet-4',
	transcriptionModel: 'google/gemini-2.5-flash',
	notificationPrefs: {
		taskCompleted: true,
		needsInput: true,
		agentErrors: true,
	},
	budgetConfig: {
		dailyLimit: null as number | null,
		monthlyLimit: null as number | null,
	},
	contextConfig: {
		reservedResponsePct: 30,
		autoCompactThresholdPct: 72,
		compactionModel: 'openai/gpt-4o-mini',
	},
	toolConfig: {
		approvalRequiredTools: [] as string[],
		programmaticToolCallingEnabled: false,
	},
	memoryConfig: {
		enabled: true,
		topK: 5,
		useRerank: false,
		rerankModel: 'anthropic/claude-haiku-4.5',
		embeddingModel: 'openai/text-embedding-3-small',
		autoMine: true,
	},
	theme: 'AgentStudio-night',
} as const

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
		compactionModel?: string
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
			defaultModel: DEFAULT_SETTINGS.defaultModel,
			theme: DEFAULT_SETTINGS.theme,
			notificationPrefs: DEFAULT_SETTINGS.notificationPrefs,
			budgetConfig: DEFAULT_SETTINGS.budgetConfig,
			contextConfig: DEFAULT_SETTINGS.contextConfig,
			toolConfig: DEFAULT_SETTINGS.toolConfig,
			memoryConfig: DEFAULT_SETTINGS.memoryConfig,
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, existing.id))
		.returning()
	return updated
}
