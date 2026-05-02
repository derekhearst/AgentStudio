import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
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
