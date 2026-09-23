import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appSettings } from '$lib/settings/settings.schema'
import { syncSettingsBudgetLimits } from '$lib/costs/budget.server'
import { logger } from '$lib/observability/logger'

/**
 * Note on `dreamConfig` + `notificationPrefs.dreamSummary`:
 * Both fields are deprecated — the spec calls dream-run config out as removed
 * (background memory work moved into the memory domain). The DB columns stay
 * for migration compatibility but the application no longer reads or writes
 * them. A future destructive migration can drop them once we're confident no
 * downstream consumer references them.
 */
export const DEFAULT_SETTINGS = {
	defaultModel: 'claude-sonnet-5',
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
	},
	toolConfig: {
		approvalRequiredTools: [] as string[],
		programmaticToolCallingEnabled: false,
	},
	memoryConfig: {
		enabled: true,
		topK: 5,
		useRerank: false,
		rerankModel: 'claude-haiku-4-5',
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

	return withBudgetLimitsSynced(input.userId, updated)
}

/**
 * The daily and monthly limits are enforced through `budget_limits` rows, which follow the
 * settings here and again at every budget check. Returns the settings as they stand after
 * the sync, which records the ids of any rows it created.
 */
async function withBudgetLimitsSynced<T extends { id: string }>(userId: string, settings: T): Promise<T> {
	try {
		await syncSettingsBudgetLimits(userId)
		const [fresh] = await db.select().from(appSettings).where(eq(appSettings.id, settings.id)).limit(1)
		return (fresh as T | undefined) ?? settings
	} catch (err) {
		// The next budget check retries; the settings themselves are saved either way.
		logger.warn('[settings] syncing the budget limits failed', { err })
		return settings
	}
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
			// The row ids stay: the sync below needs them to switch the old limits off.
			budgetConfig: { ...DEFAULT_SETTINGS.budgetConfig, limitIds: existing.budgetConfig?.limitIds },
			contextConfig: DEFAULT_SETTINGS.contextConfig,
			toolConfig: DEFAULT_SETTINGS.toolConfig,
			memoryConfig: DEFAULT_SETTINGS.memoryConfig,
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, existing.id))
		.returning()
	return withBudgetLimitsSynced(userId, updated)
}
