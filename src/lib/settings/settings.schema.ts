import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '../auth/auth.schema'

export const appSettings = pgTable('app_settings', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	defaultModel: text('default_model').notNull().default('anthropic/claude-sonnet-4'),
	transcriptionModel: text('transcription_model').notNull().default('google/gemini-2.5-flash'),
	notificationPrefs: jsonb('notification_prefs')
		.$type<{
			taskCompleted: boolean
			needsInput: boolean
			dreamSummary: boolean
			agentErrors: boolean
		}>()
		.notNull()
		.default({ taskCompleted: true, needsInput: true, dreamSummary: true, agentErrors: true }),
	dreamConfig: jsonb('dream_config')
		.$type<{
			autoRun: boolean
			frequencyHours: number
			aggressiveness: number
		}>()
		.notNull()
		.default({ autoRun: false, frequencyHours: 24, aggressiveness: 0.5 }),
	budgetConfig: jsonb('budget_config')
		.$type<{
			dailyLimit: number | null
			monthlyLimit: number | null
		}>()
		.notNull()
		.default({ dailyLimit: null, monthlyLimit: null }),
	contextConfig: jsonb('context_config')
		.$type<{
			reservedResponsePct: number
			autoCompactThresholdPct: number
			compactionModel: string
		}>()
		.notNull()
		.default({ reservedResponsePct: 30, autoCompactThresholdPct: 72, compactionModel: 'openai/gpt-4o-mini' }),
	toolConfig: jsonb('tool_config')
		.$type<{
			approvalMode: 'auto' | 'confirm'
			disabledTools: string[]
		}>()
		.notNull()
		.default({ approvalMode: 'auto', disabledTools: [] }),
	systemPrompt: text('system_prompt').notNull().default(''),
	theme: text('theme').notNull().default('drokbot-night'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
