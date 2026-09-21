import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { conversations } from '$lib/sessions/sessions.schema'

/**
 * #29 — what the right rail was last showing for a conversation.
 *
 * This is per-conversation, not per-user, which is why it isn't folded into
 * `chat_workbench_preferences` (that row is a single per-user record and would
 * turn into an unbounded conversation-keyed map). Reopening a chat restores the
 * tab and the file/URL that was being looked at.
 *
 * `target` is deliberately loose text:
 *   - kind 'file' → a workspace path (relative to the conversation's sandbox
 *     workspace, or absolute inside the user's own sandbox tree). It is
 *     re-validated through `safePathWithin` on every read, so a stale or hand-
 *     edited row can't widen what the preview endpoint will serve.
 *   - kind 'url'  → an http/https URL the user explicitly confirmed.
 *   - kind 'none' → nothing open.
 */
export const chatRailPreview = pgTable(
	'chat_rail_preview',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		conversationId: uuid('conversation_id')
			.notNull()
			.references(() => conversations.id, { onDelete: 'cascade' })
			.unique(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Active rail tab: 'Preview' | 'Research' | 'Files' | 'Activity'. */
		tab: text('tab').notNull().default('Preview'),
		/** 'none' | 'file' | 'url' */
		kind: text('kind').notNull().default('none'),
		target: text('target'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		userIdx: index('chat_rail_preview_user_idx').on(table.userId),
	}),
)
