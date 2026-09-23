import { command, query } from '$app/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { chatRailPreview } from './rail-preview.schema'
import { buildPreviewPayload, PreviewError, resolveConversationWorkspace } from './preview.server'
import { readRailOpen, writeRailOpen } from './rail-open.server'
import {
	normalizePreviewUrl,
	RAIL_TABS,
	type PreviewPayload,
	type RailPreviewState,
	type RailTab,
} from './preview-kinds'

/**
 * #29 — remote surface for the rail preview.
 *
 * Reads go through `preview.server.ts`, which re-resolves the conversation's
 * sandbox workspace on every call. Nothing here trusts a stored path: a row
 * written months ago is validated exactly like a freshly typed one.
 */

const DEFAULT_STATE: RailPreviewState = { tab: 'Preview', kind: 'none', target: null }

const railStateSchema = z.object({
	conversationId: z.string().uuid(),
	tab: z.enum(RAIL_TABS),
	kind: z.enum(['none', 'file', 'url']),
	target: z.string().max(2048).nullable(),
})

const readPreviewSchema = z.object({
	conversationId: z.string().uuid(),
	path: z.string().min(1).max(2048),
})

async function assertConversationOwned(conversationId: string, userId: string) {
	const [row] = await db
		.select({ id: conversations.id, userId: conversations.userId })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)
	if (!row) throw new Error('Conversation not found')
	if (row.userId !== userId) throw new Error('Not authorized')
}

export const getRailPreviewState = query(z.string().uuid(), async (conversationId): Promise<RailPreviewState> => {
	const user = requireAuthenticatedRequestUser()
	await assertConversationOwned(conversationId, user.id)

	const [row] = await db
		.select()
		.from(chatRailPreview)
		.where(eq(chatRailPreview.conversationId, conversationId))
		.limit(1)

	if (!row) return DEFAULT_STATE

	const tab = (RAIL_TABS as readonly string[]).includes(row.tab) ? (row.tab as RailTab) : 'Preview'
	const kind = row.kind === 'file' || row.kind === 'url' ? row.kind : 'none'
	// A stored URL is re-normalized on the way out. If it no longer passes the
	// http/https check (schema drift, a hand-edited row), it is dropped rather
	// than handed to an iframe.
	const target = kind === 'url' ? normalizePreviewUrl(row.target ?? '') : (row.target ?? null)

	return { tab, kind: target ? kind : 'none', target }
})

export const setRailPreviewState = command(railStateSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	await assertConversationOwned(input.conversationId, user.id)

	const target =
		input.kind === 'url' ? normalizePreviewUrl(input.target ?? '') : input.kind === 'file' ? (input.target ?? null) : null
	const kind = target ? input.kind : 'none'

	await db
		.insert(chatRailPreview)
		.values({
			conversationId: input.conversationId,
			userId: user.id,
			tab: input.tab,
			kind,
			target,
		})
		.onConflictDoUpdate({
			target: chatRailPreview.conversationId,
			set: { tab: input.tab, kind, target, updatedAt: new Date() },
		})

	return { ok: true }
})

/**
 * #14 — the rail's expanded/collapsed state. Per viewer rather than per chat, so it takes
 * no conversation: the caller only ever reads and writes their own preference.
 */
export const getRailOpen = query(async (): Promise<boolean> => {
	const user = requireAuthenticatedRequestUser()
	return readRailOpen(user.id)
})

export const setRailOpen = command(z.boolean(), async (open) => {
	const user = requireAuthenticatedRequestUser()
	await writeRailOpen(user.id, open)
	return { ok: true }
})

export type ReadPreviewResult = { ok: true; payload: PreviewPayload } | { ok: false; status: number; message: string }

export const readPreviewFile = query(readPreviewSchema, async (input): Promise<ReadPreviewResult> => {
	const user = requireAuthenticatedRequestUser()
	try {
		const workspace = await resolveConversationWorkspace(input.conversationId, user.id)
		const payload = await buildPreviewPayload(workspace, input.path, (displayPath) => {
			const params = new URLSearchParams({ conversationId: input.conversationId, path: displayPath })
			return `/api/preview/raw?${params.toString()}`
		})
		return { ok: true, payload }
	} catch (error) {
		if (error instanceof PreviewError) {
			return { ok: false, status: error.status, message: error.message }
		}
		const message = error instanceof Error ? error.message : String(error)
		// `safePathWithin` throws a plain Error for escapes — surface it as a refusal,
		// not as a 500, and never echo the resolved absolute path back to the client.
		if (/escapes sandbox workspace/i.test(message)) {
			return { ok: false, status: 403, message: 'Path is outside this chat’s workspace' }
		}
		return { ok: false, status: 500, message }
	}
})
