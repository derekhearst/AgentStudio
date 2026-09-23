import { lt } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { hookInvocations } from './hooks.schema'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Age-based retention for the hook log.
 *
 * The bus writes one `hook_invocations` row per handler per emit — including a global
 * handler such as `activity-impactful-tools` that returns straight away for most tools — and
 * since chats raise hook events (#144) that is a row for every chat tool call and turn. Rows
 * otherwise go only when their run is deleted, so the table grew without bound. The daily
 * `app_logs_purge` job calls this with the app log's window: both are "what happened
 * recently" records, not an audit trail.
 */
export async function purgeOldHookInvocations(retentionDays: number, now = new Date()): Promise<{ deleted: number }> {
	const cutoff = new Date(now.getTime() - retentionDays * DAY_MS)
	const result = await db
		.delete(hookInvocations)
		.where(lt(hookInvocations.createdAt, cutoff))
		.returning({ id: hookInvocations.id })
	return { deleted: result.length }
}
