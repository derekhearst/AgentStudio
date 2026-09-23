import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '../auth/auth.schema'

export const appSettings = pgTable('app_settings', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	defaultModel: text('default_model').notNull().default('claude-sonnet-5'),
	transcriptionModel: text('transcription_model').notNull().default('google/gemini-2.5-flash'),
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
			 * Tool names whose old results the pre-engine chat loop never trimmed. Nothing reads
			 * it any more: the Agent SDK manages the conversation's context itself, and the
			 * in-house trimming went with the rest of that loop (#8). Kept so stored rows parse.
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
