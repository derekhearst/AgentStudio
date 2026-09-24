import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import type { SubagentDetails, ToolResultDetails } from '$lib/engine/tool-result-details'
import type { RunNotice } from '$lib/engine/sdk-notices'
import type { AskQuestion } from '$lib/engine/ask-user-question'
import type { SubagentTranscriptEntry } from '$lib/engine/subagent-transcript'
import type { SubagentSpend } from '$lib/engine/subagent-usage'

/** Where a delegated child ended up (#32). */
export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

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
	/**
	 * As `$lib/engine/ask-user-question` normalises them. An AskUserQuestion entry (#4) carries
	 * `key` — the question text its answer is keyed by — plus `multiSelect` and per-option
	 * `preview`; an entry left by the retired `ask_user` has neither and is keyed by header.
	 * jsonb, so the wider shape needed no migration.
	 */
	questions: AskQuestion[]
	requestedAt: string
	/** Keyed by each question's `answerKey`. */
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
			/**
			 * Typed payload distilled from the SDK's `tool_use_result` for the built-ins whose
			 * output has a shape worth rendering — a diff, a terminal, a todo list. Absent for
			 * every other tool and for blocks persisted before this existed, which is what keeps
			 * it additive: a consumer that does not know about it renders the generic card, and
			 * the raw `result` string is still there either way. See `$lib/engine/tool-result-details`.
			 */
			details?: ToolResultDetails
	  }
	| {
			/**
			 * Work done by a subagent, kept out of the parent's blocks so a delegated agent's
			 * output is never read as the parent's own (#5, and the same concern as #34).
			 * `agentId` is the `Task` call's `tool_use` id — SDK subagents have no child
			 * conversation row, which is why `conversationId` is nullable.
			 */
			kind: 'subagent'
			agentId: string
			agentName: string
			conversationId: string | null
			task: string
			content: string
			success: boolean
			/*
			 * #32 — all optional, so a block persisted before them still renders (from
			 * `content` and `success`, as it always did). jsonb, so no migration.
			 */
			/** `stopped` is a child still running when the turn ended — Stop, or an interrupt. */
			status?: SubagentRunStatus
			/** What the child said and did, in order. See `$lib/engine/subagent-transcript`. */
			transcript?: SubagentTranscriptEntry[]
			transcriptTruncated?: boolean
			/** The SDK's typed result for the delegation: report, totals, usage. */
			details?: SubagentDetails
			/** Why the delegation failed or was refused, when it did not complete. */
			error?: string | null
			/** This child's ledger row's cost, stamped once it is written. */
			costUsd?: number | null
			/**
			 * What the child spent, added up over every model call it made. The ledger row and the
			 * card's token count are both this. See `$lib/engine/subagent-usage`.
			 */
			usage?: SubagentSpend
	  }
	| {
			/**
			 * A run-level event the SDK reported that is worth a line in the transcript — a
			 * compaction boundary, a model fallback, a tool a permission rule refused. Only the
			 * notices that still mean something after the turn are persisted; see
			 * `$lib/engine/sdk-notices`.
			 */
			kind: 'notice'
			notice: RunNotice
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
		// Wave 3 #14 phase 2 — when true, the runtime spawns an evaluator child run after the
		// generator finishes. Default false so existing chats have no behavior change.
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
