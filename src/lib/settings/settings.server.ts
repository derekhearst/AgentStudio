import { asc, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appSettings } from '$lib/settings/settings.schema'
import { syncSettingsBudgetLimits } from '$lib/costs/budget.server'
import { logger } from '$lib/observability/logger'
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '$lib/speech/speech'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

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
	ttsModel: DEFAULT_TTS_MODEL,
	ttsVoice: DEFAULT_TTS_VOICE,
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
	const [existing] = await readSettingsRow(userId)
	if (existing) return existing

	// app_settings has no unique index on user_id, so a check-then-insert raced: the first
	// requests of a fresh instance each saw no row and each inserted one. Everything reads the
	// oldest row, so the extras were harmless but piled up. Serialise creation per user with a
	// transaction-scoped advisory lock and check again inside it.
	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app_settings:${userId}`}))`)
		const [raced] = await readSettingsRow(userId, tx)
		if (raced) return raced
		return insertDefaultSettings(userId, tx)
	})
}

type SettingsExecutor = Pick<typeof db, 'select' | 'insert'>

function readSettingsRow(userId: string, executor: SettingsExecutor = db) {
	return executor
		.select()
		.from(appSettings)
		.where(eq(appSettings.userId, userId))
		.orderBy(asc(appSettings.createdAt))
		.limit(1)
}

async function insertDefaultSettings(userId: string, executor: SettingsExecutor) {
	const [created] = await executor
		.insert(appSettings)
		.values({
			userId,
			defaultModel: DEFAULT_SETTINGS.defaultModel,
			transcriptionModel: DEFAULT_SETTINGS.transcriptionModel,
			ttsModel: DEFAULT_SETTINGS.ttsModel,
			ttsVoice: DEFAULT_SETTINGS.ttsVoice,
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
	ttsModel?: string
	/** Empty string: the speech model's own default voice. */
	ttsVoice?: string
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
	const { id } = await getOrCreateSettings(input.userId)
	const updated = await withSettingsRowLocked(id, async (tx, current) => {
		const currentToolConfig =
			(current.toolConfig as
				| {
						approvalRequiredTools?: string[]
						approvalMode?: 'auto' | 'confirm' | 'plan'
						disabledTools?: string[]
				  }
				| undefined) ?? {}

		const migratedApprovalRequiredTools = Array.isArray(currentToolConfig.approvalRequiredTools)
			? currentToolConfig.approvalRequiredTools
			: currentToolConfig.approvalMode === 'confirm'
				? ['*']
				: []
		const currentBudgetConfig = current.budgetConfig ?? DEFAULT_SETTINGS.budgetConfig
		const [row] = await tx
			.update(appSettings)
			.set({
				defaultModel: input.defaultModel ?? current.defaultModel,
				transcriptionModel: input.transcriptionModel ?? current.transcriptionModel,
				ttsModel: input.ttsModel ?? current.ttsModel,
				ttsVoice: input.ttsVoice ?? current.ttsVoice,
				theme: 'AgentStudio-night',
				notificationPrefs: {
					...current.notificationPrefs,
					...(input.notificationPrefs ?? {}),
				},
				budgetConfig: {
					...currentBudgetConfig,
					...(input.budgetConfig ?? {}),
					// The budget sync's to write, never a caller's.
					limitIds: currentBudgetConfig.limitIds,
				},
				contextConfig: {
					...((current.contextConfig as typeof DEFAULT_SETTINGS.contextConfig | undefined) ??
						DEFAULT_SETTINGS.contextConfig),
					...(input.contextConfig ?? {}),
				},
				toolConfig: {
					approvalRequiredTools: migratedApprovalRequiredTools,
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
		return row
	})

	return withBudgetLimitsSynced(input.userId, updated)
}

/**
 * Read, merge and write the settings row under its lock.
 *
 * `syncSettingsBudgetLimits` records the ids of the budget rows it creates in
 * `budget_config.limitIds`, under this same lock. A save that merged from an unlocked read
 * could write back a copy taken before that and drop the new id. The row it named would go
 * on blocking at its old amount with nothing left pointing at it, and the next sync would
 * create a second one.
 */
async function withSettingsRowLocked<T>(
	id: string,
	write: (tx: Tx, current: typeof appSettings.$inferSelect) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		const [current] = await tx.select().from(appSettings).where(eq(appSettings.id, id)).for('update')
		if (!current) throw new Error(`Settings row ${id} no longer exists`)
		return write(tx, current)
	})
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
		.select({ id: appSettings.id })
		.from(appSettings)
		.where(eq(appSettings.userId, userId))
		.orderBy(asc(appSettings.createdAt))
		.limit(1)
	if (!existing) {
		return getOrCreateSettings(userId)
	}

	const updated = await withSettingsRowLocked(existing.id, async (tx, current) => {
		const [row] = await tx
			.update(appSettings)
			.set({
				// Every default, by spreading the one list of them. This used to name the fields
				// one by one and missed `transcriptionModel`, so Reset said "Settings reset to
				// defaults." and left the transcription model as it was. The read-aloud model and
				// voice (#27) are in the list, so they come back too.
				...DEFAULT_SETTINGS,
				// The budget row ids stay: the sync below needs them to switch the old limits off.
				budgetConfig: { ...DEFAULT_SETTINGS.budgetConfig, limitIds: current.budgetConfig?.limitIds },
				updatedAt: new Date(),
			})
			.where(eq(appSettings.id, current.id))
			.returning()
		return row
	})
	return withBudgetLimitsSynced(userId, updated)
}
