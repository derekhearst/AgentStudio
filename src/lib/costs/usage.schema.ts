import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { chatRuns } from '$lib/runs/runs.schema'

export const llmUsage = pgTable(
	'llm_usage',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		source: text('source').notNull(), // 'chat' | 'agent_planner' | 'agent_synthesis' | 'titlegen' | 'image_gen'
		model: text('model').notNull(),
		tokensIn: integer('tokens_in').notNull().default(0),
		tokensOut: integer('tokens_out').notNull().default(0),
		cost: numeric('cost', { precision: 18, scale: 12 }).notNull().default('0'),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
		runId: uuid('run_id').references(() => chatRuns.id, { onDelete: 'set null' }),
		// taskId is reserved for the future tasks domain (item #11). No FK yet because
		// the tasks table does not exist; nullable column allows back-population later.
		taskId: uuid('task_id'),
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		userIdx: index('llm_usage_user_idx').on(table.userId),
		runIdx: index('llm_usage_run_idx').on(table.runId),
		taskIdx: index('llm_usage_task_idx').on(table.taskId),
		agentIdx: index('llm_usage_agent_idx').on(table.agentId),
		createdIdx: index('llm_usage_created_idx').on(table.createdAt),
	}),
)

export const toolUsage = pgTable(
	'tool_usage',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
		runId: uuid('run_id').references(() => chatRuns.id, { onDelete: 'set null' }),
		taskId: uuid('task_id'), // tasks table does not exist yet; back-populate when item #11 lands
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
		toolName: text('tool_name').notNull(),
		provider: text('provider'),
		unitType: text('unit_type').notNull(), // 'credit' | 'second' | 'call' | 'mb'
		units: numeric('units', { precision: 18, scale: 6 }).notNull().default('0'),
		cost: numeric('cost', { precision: 18, scale: 12 }).notNull().default('0'),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		userIdx: index('tool_usage_user_idx').on(table.userId),
		runIdx: index('tool_usage_run_idx').on(table.runId),
		taskIdx: index('tool_usage_task_idx').on(table.taskId),
		agentIdx: index('tool_usage_agent_idx').on(table.agentId),
		toolIdx: index('tool_usage_tool_idx').on(table.toolName),
		createdIdx: index('tool_usage_created_idx').on(table.createdAt),
	}),
)
