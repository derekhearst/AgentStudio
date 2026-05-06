import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Generated-image audit table.
 *
 * Every successful `image_generate` tool call inserts one row here so the
 * /artifacts feed can list past images alongside research reports and project
 * artifacts. The `url` column points at the provider-hosted image (currently
 * OpenRouter) — those URLs may eventually expire, so this row primarily acts
 * as a durable record of "what was generated, when, by whom, with what
 * prompt/cost"; the actual bytes can be rehydrated later if we ever move to
 * local storage.
 *
 * Cross-domain pointers (`conversationId`, `runId`) are declared by-name to
 * avoid circular imports — same convention as `research.schema.ts`.
 */
export const images = pgTable(
	'images',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
		// Best-effort link back to the chat that produced the image. Both nullable so
		// non-chat-triggered generations (automation, batch tools) still record.
		conversationId: uuid('conversation_id'),
		runId: uuid('run_id'),
		prompt: text('prompt').notNull(),
		model: text('model').notNull(),
		size: text('size'),
		// Provider-hosted image URL. May 404 once the provider expires it; the row still
		// remains as an audit record.
		url: text('url').notNull(),
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		userIdx: index('images_user_idx').on(t.userId),
		conversationIdx: index('images_conversation_idx').on(t.conversationId),
		createdIdx: index('images_created_idx').on(t.createdAt),
	}),
)

export type ImageRow = typeof images.$inferSelect
