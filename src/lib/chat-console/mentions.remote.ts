import { query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { MAX_TRIGGER_QUERY } from '$lib/chat/composer-trigger'
import { searchConversationFiles } from './mentions.server'

/**
 * #22 — the composer's `@` file search, for the conversation the caller owns.
 *
 * Returns workspace-relative paths only. What is listed, and when there is nothing to list,
 * is decided in `mentions.server.ts`.
 */

const searchSchema = z.object({
	conversationId: z.string().uuid(),
	q: z
		.string()
		.max(MAX_TRIGGER_QUERY)
		.refine((q) => !q.includes('\0'), 'Invalid query'),
})

export const searchWorkspaceFiles = query(searchSchema, async ({ conversationId, q }) => {
	const user = requireAuthenticatedRequestUser()
	return searchConversationFiles({ conversationId, userId: user.id, query: q })
})
