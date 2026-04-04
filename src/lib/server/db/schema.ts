import {
	boolean,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	uuid,
	vector,
} from 'drizzle-orm/pg-core'

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool'])
export const memoryRelationTypeEnum = pgEnum('memory_relation_type', [
	'supports',
	'contradicts',
	'depends_on',
	'part_of',
])
export const agentStatusEnum = pgEnum('agent_status', ['active', 'paused', 'idle'])
export const taskStatusEnum = pgEnum('task_status', [
	'pending',
	'running',
	'completed',
	'failed',
	'review',
	'changes_requested',
])
export const reviewTypeEnum = pgEnum('review_type', ['heavy', 'quick', 'informational'])
export const activityEventTypeEnum = pgEnum('activity_event_type', [
	'task_created',
	'task_status_changed',
	'agent_action',
	'memory_created',
	'dream_cycle',
	'chat_started',
	'review_action',
])

export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const conversations = pgTable('conversations', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: text('title').notNull(),
	category: text('category'),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
	model: text('model').notNull().default('anthropic/claude-sonnet-4'),
	totalTokens: integer('total_tokens').notNull().default(0),
	totalCost: numeric('total_cost', { precision: 12, scale: 6 }).notNull().default('0'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const messages = pgTable('messages', {
	id: uuid('id').primaryKey().defaultRandom(),
	conversationId: uuid('conversation_id')
		.notNull()
		.references(() => conversations.id, { onDelete: 'cascade' }),
	role: messageRoleEnum('role').notNull(),
	content: text('content').notNull(),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
	toolCalls: jsonb('tool_calls').$type<Array<Record<string, unknown>>>().notNull().default([]),
	attachments: jsonb('attachments')
		.$type<Array<{ id: string; filename: string; mimeType: string; size: number; url: string }>>()
		.notNull()
		.default([]),
	model: text('model'),
	tokensIn: integer('tokens_in').notNull().default(0),
	tokensOut: integer('tokens_out').notNull().default(0),
	cost: numeric('cost', { precision: 12, scale: 6 }).notNull().default('0'),
	ttftMs: integer('ttft_ms'),
	totalMs: integer('total_ms'),
	tokensPerSec: real('tokens_per_sec'),
	parentMessageId: uuid('parent_message_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const memories = pgTable('memories', {
	id: uuid('id').primaryKey().defaultRandom(),
	content: text('content').notNull(),
	category: text('category').notNull().default('general'),
	importance: real('importance').notNull().default(0.5),
	embedding: vector('embedding', { dimensions: 1536 }),
	accessCount: integer('access_count').notNull().default(0),
	lastAccessed: timestamp('last_accessed', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	decayedAt: timestamp('decayed_at', { withTimezone: true }),
})

export const memoryRelations = pgTable('memory_relations', {
	id: uuid('id').primaryKey().defaultRandom(),
	sourceMemoryId: uuid('source_memory_id')
		.notNull()
		.references(() => memories.id, { onDelete: 'cascade' }),
	targetMemoryId: uuid('target_memory_id')
		.notNull()
		.references(() => memories.id, { onDelete: 'cascade' }),
	relationType: memoryRelationTypeEnum('relation_type').notNull(),
	strength: real('strength').notNull().default(0.5),
})

export const agents = pgTable('agents', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	role: text('role').notNull(),
	systemPrompt: text('system_prompt').notNull(),
	model: text('model').notNull().default('anthropic/claude-sonnet-4'),
	config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
	status: agentStatusEnum('status').notNull().default('idle'),
	parentAgentId: uuid('parent_agent_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const agentTasks = pgTable('agent_tasks', {
	id: uuid('id').primaryKey().defaultRandom(),
	agentId: uuid('agent_id')
		.notNull()
		.references(() => agents.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	description: text('description').notNull(),
	status: taskStatusEnum('status').notNull().default('pending'),
	priority: integer('priority').notNull().default(2),
	result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
	gitBranch: text('git_branch'),
	reviewType: reviewTypeEnum('review_type'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	completedAt: timestamp('completed_at', { withTimezone: true }),
})

export const agentRuns = pgTable('agent_runs', {
	id: uuid('id').primaryKey().defaultRandom(),
	agentId: uuid('agent_id')
		.notNull()
		.references(() => agents.id, { onDelete: 'cascade' }),
	taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
	startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
	endedAt: timestamp('ended_at', { withTimezone: true }),
	tokenUsage: jsonb('token_usage').$type<Record<string, unknown>>().notNull().default({}),
	cost: numeric('cost', { precision: 12, scale: 6 }).notNull().default('0'),
	logs: jsonb('logs').$type<Array<Record<string, unknown>>>().notNull().default([]),
})

export const dreamCycles = pgTable('dream_cycles', {
	id: uuid('id').primaryKey().defaultRandom(),
	startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
	endedAt: timestamp('ended_at', { withTimezone: true }),
	memoriesProcessed: integer('memories_processed').notNull().default(0),
	memoriesCreated: integer('memories_created').notNull().default(0),
	memoriesPruned: integer('memories_pruned').notNull().default(0),
	summary: text('summary'),
})

export const notifications = pgTable('notifications', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	body: text('body').notNull(),
	url: text('url'),
	read: boolean('read').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const pushSubscriptions = pgTable('push_subscriptions', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	endpoint: text('endpoint').notNull(),
	keys: jsonb('keys').$type<{ p256dh: string; auth: string }>().notNull(),
	deviceLabel: text('device_label'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const appSettings = pgTable('app_settings', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
	defaultModel: text('default_model').notNull().default('anthropic/claude-sonnet-4'),
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
	theme: text('theme').notNull().default('drokbot'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Phase A: Activity Feed ---
export const activityEvents = pgTable('activity_events', {
	id: uuid('id').primaryKey().defaultRandom(),
	type: activityEventTypeEnum('type').notNull(),
	entityId: text('entity_id'),
	entityType: text('entity_type'),
	summary: text('summary').notNull(),
	metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Phase B: Task Comments & Task Messages ---
export const taskComments = pgTable('task_comments', {
	id: uuid('id').primaryKey().defaultRandom(),
	taskId: uuid('task_id')
		.notNull()
		.references(() => agentTasks.id, { onDelete: 'cascade' }),
	role: messageRoleEnum('role').notNull().default('user'),
	content: text('content').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const taskMessages = pgTable('task_messages', {
	id: uuid('id').primaryKey().defaultRandom(),
	taskId: uuid('task_id')
		.notNull()
		.references(() => agentTasks.id, { onDelete: 'cascade' }),
	role: messageRoleEnum('role').notNull(),
	content: text('content').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
