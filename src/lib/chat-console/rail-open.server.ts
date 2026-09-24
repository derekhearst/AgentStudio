import { eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { chatWorkbenchPreferences } from '$lib/chat/chat.workbench.schema'

/**
 * #14 — whether the chat's right rail is expanded or folded to its strip, per viewer.
 *
 * The rail starts collapsed and expands when something opens a preview or the viewer asks
 * for it. Which way they left it is remembered on their `chat_workbench_preferences` row
 * (`panel_layout.railOpen`), the per-user counterpart of the per-conversation
 * `chat_rail_preview` row: the selection belongs to a chat, the panel's width and fold
 * belong to the person looking at it.
 *
 * `panel_layout` is jsonb, so this needs no migration, and the write merges the one key
 * rather than replacing the object, so anything else stored there survives.
 */

export async function readRailOpen(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ panelLayout: chatWorkbenchPreferences.panelLayout })
		.from(chatWorkbenchPreferences)
		.where(eq(chatWorkbenchPreferences.userId, userId))
		.limit(1)
	return row?.panelLayout?.railOpen === true
}

export async function writeRailOpen(userId: string, open: boolean): Promise<void> {
	await db
		.insert(chatWorkbenchPreferences)
		.values({ userId, panelLayout: { railOpen: open } })
		.onConflictDoUpdate({
			target: chatWorkbenchPreferences.userId,
			set: {
				panelLayout: sql`coalesce(${chatWorkbenchPreferences.panelLayout}, '{}'::jsonb) || jsonb_build_object('railOpen', ${open}::boolean)`,
				updatedAt: new Date(),
			},
		})
}
