import { sql, type SQL } from 'drizzle-orm'
import {
	customType,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import type { TodoItem } from '$lib/engine/tool-result-details'

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool'])

/**
 * #19 — per-conversation permission mode. Values mirror `PERMISSION_MODES` in
 * `$lib/engine/permission-mode` (kept as a literal list here so the schema file stays free
 * of application imports; `tests/engine.permission-mode.spec.ts` pins the two together).
 */
export const conversationPermissionModeEnum = pgEnum('conversation_permission_mode', [
	'default',
	'plan',
	'acceptEdits',
	'bypassPermissions',
])

/**
 * #21 — the agent's checklist, kept on the conversation rather than the run.
 *
 * `TodoWrite` output already reaches the transcript as a tool block, but a checklist
 * scrolls away the moment the model says anything after it, and a task that takes three
 * turns has three of them buried at three different depths. This is the current one: last
 * write wins, because that is exactly what `TodoWrite` means.
 *
 * On the conversation and not on `chat_runs` because a plan routinely outlives the run that
 * wrote it — the user answers a question, the next run continues the same list, and a
 * per-run column would show an empty checklist for the turn that is actually doing the work.
 */
export type ConversationTodoList = {
	items: TodoItem[]
	/** ISO timestamp of the write, so a stale list can be shown as stale. */
	updatedAt: string
	/** The run that wrote it, for tracing a list back to its turn. Null for older rows. */
	runId: string | null
}

export const conversations = pgTable('conversations', {
	id: uuid('id').primaryKey().defaultRandom(),
	title: text('title').notNull(),
	category: text('category'),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
	// Conversations are bound to an agent — the four built-in agents (chat / research / plan
	// / autonomous, seeded by `seedBuiltinAgents`) replace what used to be a `mode` enum.
	// Nullable at the DB layer so historical rows survive a migration; the application
	// guarantees a non-null id via `resolveDefaultAgentId` on every new conversation insert.
	agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
	model: text('model').notNull().default('claude-sonnet-5'),
	// Wave 4 #15 phase 2 — bind a conversation to a project so subsequent agent edits know
	// where to write new files. Declared by-name (no enforced FK) to avoid a circular import
	// with $lib/projects. SET NULL semantics enforced via application logic when a project
	// is deleted (the conversation back-reference becomes a tombstone).
	projectId: uuid('project_id'),
	totalTokens: integer('total_tokens').notNull().default(0),
	totalCost: numeric('total_cost', { precision: 18, scale: 12 }).notNull().default('0'),
	// Claude Agent SDK session id. The SDK owns turn-to-turn conversation state, so
	// subsequent turns `resume` this instead of us rebuilding the message history
	// on every request. Null until the first run completes, and for conversations
	// that predate the engine migration — those start a fresh SDK session.
	sdkSessionId: text('sdk_session_id'),
	// #19 — how much this session is allowed to do without asking. Orthogonal to the bound
	// agent: the agent sets the persona, this sets what the runtime permits. Changeable
	// mid-session; the next turn picks it up. `bypassPermissions` never reaches a detached
	// or automation run — see `resolveEffectivePermissionMode`.
	permissionMode: conversationPermissionModeEnum('permission_mode').notNull().default('default'),
	// #21 — the latest `TodoWrite` list for this conversation. Null until the agent writes
	// one, and cleared when the user dismisses it. See `ConversationTodoList` above.
	todoList: jsonb('todo_list').$type<ConversationTodoList | null>(),
	// #18 — conversation lifecycle. Both are timestamps rather than booleans: set means "on",
	// and the time is worth having — pinned chats list in the order they were pinned, and
	// the archive shows when something was put away. Neither moves `updatedAt`, so pinning or
	// archiving a chat never reorders it. Archiving clears the pin, pinning clears the
	// archive, and a message the user sends brings an archived chat back (see
	// `$lib/chat/conversation-lifecycle.server`).
	pinnedAt: timestamp('pinned_at', { withTimezone: true }),
	archivedAt: timestamp('archived_at', { withTimezone: true }),
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
	cost: numeric('cost', { precision: 18, scale: 12 }).notNull().default('0'),
	ttftMs: integer('ttft_ms'),
	totalMs: integer('total_ms'),
	tokensPerSec: real('tokens_per_sec'),
	parentMessageId: uuid('parent_message_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	// Per-conversation monotonic counter assigned at insert time. Replaces the old
	// "order by created_at, id" workaround — millisecond timestamp ties between
	// user/assistant rows on fast turns no longer affect render order. Always
	// written via insertMessageWithSequence() so the (conversation_id, sequence)
	// unique index serializes racing writers.
	sequence: integer('sequence').notNull(),
})

/**
 * Postgres's full-text document type. Drizzle has no built-in for it; this is the
 * documented `customType` pattern.
 */
const tsvector = customType<{ data: string }>({
	dataType() {
		return 'tsvector'
	},
})

/**
 * #18 — the search index behind "search across conversations".
 *
 * One row per message, holding the text worth finding it by (`body`) and the parsed
 * document Postgres searches (`tsv`, generated from `body` and GIN-indexed). `body` is
 * built by `buildMessageSearchText`: the message text, attachment names and — the part
 * that makes it find *work* rather than prose — each tool call's name, file paths,
 * commands and short arguments. Raw tool output and file contents are left out.
 *
 * A side table rather than columns on `messages` because the chat page loads messages with
 * `select()`, which would ship the search text to the browser with every conversation; and
 * because it can be rebuilt: a change to what is indexed bumps `SEARCH_BUILDER_VERSION`,
 * and the boot backfill rewrites every row whose `builderVersion` is older.
 *
 * Written after the message is committed, best-effort: indexing never fails a message
 * write, and anything missed is picked up by the backfill (`$lib/chat/message-search.server`).
 */
export const messageSearch = pgTable(
	'message_search',
	{
		messageId: uuid('message_id')
			.primaryKey()
			.references(() => messages.id, { onDelete: 'cascade' }),
		conversationId: uuid('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' }),
		body: text('body').notNull(),
		builderVersion: integer('builder_version').notNull(),
		tsv: tsvector('tsv').generatedAlwaysAs((): SQL => sql`to_tsvector('english', ${messageSearch.body})`),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index('message_search_tsv_idx').using('gin', table.tsv),
		index('message_search_conversation_idx').on(table.conversationId),
	],
)
