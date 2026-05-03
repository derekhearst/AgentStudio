import {
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 2 #11 phase 1 — task lifecycle schema.
 *
 * A `task` is the durable unit of work the orchestrator commits to (one row per planned step
 * after the user approves a `propose_plan` proposal). A `task_attempt` is one execution of a
 * task — typically one chat_run, but a failure spawns a new attempt against the same task.
 *
 * The orchestrator integration (#11 phase 2) will write task rows directly from `propose_plan`'s
 * structured payload. This phase only lays the schema + helpers; nothing reads the tables yet.
 */
export const taskStatusEnum = pgEnum('task_status', [
	'pending',
	'planning',
	'awaiting_approval',
	'running',
	'blocked',
	'completed',
	'failed',
	'canceled',
])

export const taskAttemptStatusEnum = pgEnum('task_attempt_status', [
	'queued',
	'running',
	'completed',
	'failed',
	'canceled',
])

export const tasks = pgTable(
	'tasks',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		title: text('title').notNull(),
		spec: text('spec').notNull(),
		status: taskStatusEnum('status').notNull().default('pending'),
		// DAG linkage — a planning step can spawn child tasks; cascade so deleting a parent
		// trims the whole subtree. Self-FK declared by name (drizzle requires the table name as
		// a string for self-references in pgTable).
		parentTaskId: uuid('parent_task_id'),
		ownerAgentId: uuid('owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
		// First conversation that produced the task — useful for "open the originating chat".
		rootConversationId: uuid('root_conversation_id').references(() => conversations.id, {
			onDelete: 'set null',
		}),
		priority: integer('priority').notNull().default(0),
		// Soft cap on cumulative cost across attempts; null = unbounded. Numeric to match
		// llm_usage / tool_usage cost columns.
		budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }),
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		statusIdx: index('tasks_status_idx').on(table.status),
		parentIdx: index('tasks_parent_idx').on(table.parentTaskId),
		ownerIdx: index('tasks_owner_idx').on(table.ownerAgentId),
		createdByIdx: index('tasks_created_by_idx').on(table.createdBy),
		rootConversationIdx: index('tasks_root_conversation_idx').on(table.rootConversationId),
	}),
)

export const taskAttempts = pgTable(
	'task_attempts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		taskId: uuid('task_id')
			.notNull()
			.references(() => tasks.id, { onDelete: 'cascade' }),
		// `runId` references chat_runs (the only kind of run today). Declared by-name to avoid a
		// circular import — chat_runs gains a back-pointer to taskAttempts in a follow-up patch
		// in this same migration.
		runId: uuid('run_id'),
		attemptNumber: integer('attempt_number').notNull(),
		status: taskAttemptStatusEnum('status').notNull().default('queued'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		error: text('error'),
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		taskIdx: index('task_attempts_task_idx').on(table.taskId),
		runIdx: index('task_attempts_run_idx').on(table.runId),
		statusIdx: index('task_attempts_status_idx').on(table.status),
	}),
)
