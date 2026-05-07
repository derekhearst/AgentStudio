import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'

export const chatRunStateEnum = pgEnum('chat_run_state', [
	'queued',
	'running',
	'waiting_tool_approval',
	'waiting_user_input',
	'waiting_plan_decision',
	'completed',
	'failed',
	'canceled',
])

export const chatRunSourceEnum = pgEnum('chat_run_source', ['chat_stream', 'agent_subagent', 'automation'])

export type PendingApprovalEntry = {
	token: string
	toolName: string
	args: unknown
	requestedAt: string
	decision?: 'approved' | 'denied'
	decidedAt?: string
}

export type PendingQuestionEntry = {
	token: string
	questions: Array<{
		header: string
		question: string
		options: Array<{
			label: string
			description?: string
			recommended?: boolean
		}>
		allowFreeformInput: boolean
	}>
	requestedAt: string
	answers?: Record<string, string>
	decidedAt?: string
}

export type StreamBlock =
	| { kind: 'thinking'; content: string; reasoningTokens?: number | null }
	| { kind: 'text'; content: string }
	| {
			kind: 'tool'
			name: string
			arguments: unknown
			result: unknown
			success: boolean
			executionMs: number
	  }

export type RunEventPayload = unknown

export const chatRuns = pgTable(
	'chat_runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		conversationId: uuid('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
		state: chatRunStateEnum('state').notNull().default('queued'),
		source: chatRunSourceEnum('source').notNull().default('chat_stream'),
		label: text('label'),
		error: text('error'),
		lastDelta: text('last_delta'),
		pendingApprovals: jsonb('pending_approvals').$type<PendingApprovalEntry[]>().notNull().default([]),
		pendingQuestions: jsonb('pending_questions').$type<PendingQuestionEntry[]>().notNull().default([]),
		streamBlocks: jsonb('stream_blocks').$type<StreamBlock[]>().notNull().default([]),
		currentRound: integer('current_round').notNull().default(0),
		nextEventSeq: integer('next_event_seq').notNull().default(0),
		// Wave 2 #11 phase 1 — optional task linkage. Set when a run is the materialization of a
		// planned task (post-orchestrator-emits-tasks integration in phase 2). Foreign keys point
		// at tasks/task_attempts; declared by-name to avoid a circular import (tasks.schema also
		// references runs).
		taskId: uuid('task_id'),
		taskAttemptId: uuid('task_attempt_id'),
		// Wave 3 #14 phase 2 — when true, the runtime spawns an evaluator child run after the
		// generator finishes. Evaluator's verdict gates whether the originating task can complete
		// (Phase 4) or whether to spawn a re-plan retry (Phase 3). Default false so existing chats
		// have no behavior change.
		evalRequired: boolean('eval_required').notNull().default(false),
		// How many evaluator attempts have already happened for this run — incremented when a
		// retry is spawned to prevent infinite re-plan loops.
		evalAttempt: integer('eval_attempt').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		startedAt: timestamp('started_at', { withTimezone: true }),
		lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		conversationIdx: index('chat_runs_conversation_idx').on(table.conversationId),
		userIdx: index('chat_runs_user_idx').on(table.userId),
		agentIdx: index('chat_runs_agent_idx').on(table.agentId),
		stateIdx: index('chat_runs_state_idx').on(table.state),
		updatedIdx: index('chat_runs_updated_idx').on(table.updatedAt),
		taskIdx: index('chat_runs_task_idx').on(table.taskId),
		taskAttemptIdx: index('chat_runs_task_attempt_idx').on(table.taskAttemptId),
	}),
)

export const runEvents = pgTable(
	'run_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		runId: uuid('run_id')
			.notNull()
			.references(() => chatRuns.id, { onDelete: 'cascade' }),
		seq: integer('seq').notNull(),
		type: text('type').notNull(),
		payload: jsonb('payload').$type<RunEventPayload>().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		runSeqIdx: index('run_events_run_seq_idx').on(table.runId, table.seq),
	}),
)
