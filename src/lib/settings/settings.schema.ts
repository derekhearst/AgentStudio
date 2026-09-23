import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '../auth/auth.schema'

export const appSettings = pgTable('app_settings', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	defaultModel: text('default_model').notNull().default('claude-sonnet-5'),
	transcriptionModel: text('transcription_model').notNull().default('google/gemini-2.5-flash'),
	// #27 — read-aloud: an OpenRouter speech model and one of the voices it lists. An empty
	// voice lets the model use its own default. Same values as DEFAULT_TTS_MODEL / _VOICE.
	ttsModel: text('tts_model').notNull().default('hexgrad/kokoro-82m'),
	ttsVoice: text('tts_voice').notNull().default('af_heart'),
	notificationPrefs: jsonb('notification_prefs')
		.$type<{
			taskCompleted: boolean
			needsInput: boolean
			agentErrors: boolean
		}>()
		.notNull()
		.default({ taskCompleted: true, needsInput: true, agentErrors: true }),
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
			/**
			 * Tool names whose results should never be trimmed by trimHistoricalToolResults.
			 * Use for tools whose output the model should be able to refer back to indefinitely
			 * (e.g. request_plan_approval). Empty / unset = trim by default rules.
			 */
			preserveToolResults?: string[]
		}>()
		.notNull()
		.default({ reservedResponsePct: 30, autoCompactThresholdPct: 72 }),
	toolConfig: jsonb('tool_config')
		.$type<{
			approvalRequiredTools: string[]
			programmaticToolCallingEnabled?: boolean
		}>()
		.notNull()
		.default({ approvalRequiredTools: [] }),
	memoryConfig: jsonb('memory_config')
		.$type<{
			enabled: boolean
			topK: number
			useRerank: boolean
			rerankModel: string
			embeddingModel: string
			autoMine: boolean
		}>()
		.notNull()
		.default({
			enabled: true,
			topK: 5,
			useRerank: false,
			rerankModel: 'claude-haiku-4-5',
			embeddingModel: 'openai/text-embedding-3-small',
			autoMine: true,
		}),
	systemPrompt: text('system_prompt').notNull().default(''), // deprecated – kept for migration compat
	theme: text('theme').notNull().default('AgentStudio-night'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
