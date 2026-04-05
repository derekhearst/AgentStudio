import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appSettings } from '$lib/settings/settings.schema'

export const DEFAULT_SETTINGS = {
	defaultModel: 'anthropic/claude-sonnet-4',
	transcriptionModel: 'google/gemini-2.5-flash',
	notificationPrefs: {
		taskCompleted: true,
		needsInput: true,
		dreamSummary: true,
		agentErrors: true,
	},
	dreamConfig: {
		autoRun: false,
		frequencyHours: 24,
		aggressiveness: 0.5,
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
		approvalMode: 'auto' as const,
	},
	systemPrompt: '',
	theme: 'drokbot-night',
} as const

export async function getOrCreateSettings() {
	const [existing] = await db.select().from(appSettings).orderBy(asc(appSettings.createdAt)).limit(1)
	if (existing) return existing

	const [created] = await db
		.insert(appSettings)
		.values({
			defaultModel: DEFAULT_SETTINGS.defaultModel,
			transcriptionModel: DEFAULT_SETTINGS.transcriptionModel,
			notificationPrefs: DEFAULT_SETTINGS.notificationPrefs,
			dreamConfig: DEFAULT_SETTINGS.dreamConfig,
			contextConfig: DEFAULT_SETTINGS.contextConfig,
			toolConfig: DEFAULT_SETTINGS.toolConfig,
			systemPrompt: DEFAULT_SETTINGS.systemPrompt,
			theme: DEFAULT_SETTINGS.theme,
			updatedAt: new Date(),
		})
		.returning()
	return created
}

export async function updateSettings(input: {
	defaultModel?: string
	transcriptionModel?: string
	theme?: string
	notificationPrefs?: {
		taskCompleted?: boolean
		needsInput?: boolean
		dreamSummary?: boolean
		agentErrors?: boolean
	}
	dreamConfig?: {
		autoRun?: boolean
		frequencyHours?: number
		aggressiveness?: number
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
		approvalMode?: 'auto' | 'confirm'
	}
	systemPrompt?: string
}) {
	const current = await getOrCreateSettings()
	const [updated] = await db
		.update(appSettings)
		.set({
			defaultModel: input.defaultModel ?? current.defaultModel,
			transcriptionModel: input.transcriptionModel ?? current.transcriptionModel,
			theme: 'drokbot-night',
			notificationPrefs: {
				...current.notificationPrefs,
				...(input.notificationPrefs ?? {}),
			},
			dreamConfig: {
				...current.dreamConfig,
				...(input.dreamConfig ?? {}),
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
				...((current.toolConfig as typeof DEFAULT_SETTINGS.toolConfig | undefined) ?? DEFAULT_SETTINGS.toolConfig),
				...(input.toolConfig ?? {}),
			},
			systemPrompt: input.systemPrompt ?? current.systemPrompt,
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, current.id))
		.returning()

	return updated
}

export async function resetSettings() {
	const [existing] = await db.select().from(appSettings).orderBy(asc(appSettings.createdAt)).limit(1)
	if (!existing) {
		return getOrCreateSettings()
	}

	const [updated] = await db
		.update(appSettings)
		.set({
			defaultModel: DEFAULT_SETTINGS.defaultModel,
			theme: DEFAULT_SETTINGS.theme,
			notificationPrefs: DEFAULT_SETTINGS.notificationPrefs,
			dreamConfig: DEFAULT_SETTINGS.dreamConfig,
			budgetConfig: DEFAULT_SETTINGS.budgetConfig,
			contextConfig: DEFAULT_SETTINGS.contextConfig,
			toolConfig: DEFAULT_SETTINGS.toolConfig,
			systemPrompt: DEFAULT_SETTINGS.systemPrompt,
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, existing.id))
		.returning()
	return updated
}
