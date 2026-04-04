import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/server/db'
import { appSettings } from '$lib/server/db/schema'

export const DEFAULT_SETTINGS = {
	defaultModel: 'anthropic/claude-sonnet-4',
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
	theme: 'drokbot',
} as const

export async function getOrCreateSettings() {
	const [existing] = await db.select().from(appSettings).orderBy(asc(appSettings.createdAt)).limit(1)
	if (existing) return existing

	const [created] = await db
		.insert(appSettings)
		.values({
			defaultModel: DEFAULT_SETTINGS.defaultModel,
			notificationPrefs: DEFAULT_SETTINGS.notificationPrefs,
			dreamConfig: DEFAULT_SETTINGS.dreamConfig,
			theme: DEFAULT_SETTINGS.theme,
			updatedAt: new Date(),
		})
		.returning()
	return created
}

export async function updateSettings(input: {
	defaultModel?: string
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
}) {
	const current = await getOrCreateSettings()
	const [updated] = await db
		.update(appSettings)
		.set({
			defaultModel: input.defaultModel ?? current.defaultModel,
			theme: input.theme ?? current.theme,
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
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, existing.id))
		.returning()
	return updated
}
