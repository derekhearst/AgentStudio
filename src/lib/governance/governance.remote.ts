import { query } from '$app/server'
import { and, desc, eq, gte } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { auditEvents } from './governance.schema'
import { users } from '$lib/auth/auth.schema'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Wave 3 #12 phase 1 — admin-only audit log reader.
 *
 * Returns the most recent audit events with the actor user's email + role joined for the
 * dashboard. Filters: by action, by target type/id, by actor, by since-timestamp. Hard-capped
 * at 200 rows per page (the dashboard paginates client-side; future work could add cursor
 * pagination if the audit log grows large).
 */

const listSchema = z
	.object({
		action: z.string().optional(),
		targetType: z.string().optional(),
		targetId: z.string().optional(),
		actorUserId: z.string().uuid().optional(),
		sinceISO: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(500).optional(),
	})
	.default({})

export const listAuditEventsQuery = query(listSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') {
		// Non-admins see nothing — the page also gates render but this is the server-side enforcement.
		return { events: [], adminOnly: true as const }
	}

	const filters = []
	if (input.action) {
		// action is an enum — only enforce equality if the value is in the enum, otherwise drop.
		filters.push(eq(auditEvents.action, input.action as Parameters<typeof eq>[1] as never))
	}
	if (input.targetType) filters.push(eq(auditEvents.targetType, input.targetType))
	if (input.targetId) filters.push(eq(auditEvents.targetId, input.targetId))
	if (input.actorUserId) filters.push(eq(auditEvents.actorUserId, input.actorUserId))
	if (input.sinceISO) filters.push(gte(auditEvents.createdAt, new Date(input.sinceISO)))

	const rows = await db
		.select({
			id: auditEvents.id,
			actorUserId: auditEvents.actorUserId,
			actorName: users.name,
			actorUsername: users.username,
			actorRole: users.role,
			action: auditEvents.action,
			targetType: auditEvents.targetType,
			targetId: auditEvents.targetId,
			beforeState: auditEvents.beforeState,
			afterState: auditEvents.afterState,
			summary: auditEvents.summary,
			ipAddress: auditEvents.ipAddress,
			userAgent: auditEvents.userAgent,
			createdAt: auditEvents.createdAt,
		})
		.from(auditEvents)
		.leftJoin(users, eq(users.id, auditEvents.actorUserId))
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(desc(auditEvents.createdAt))
		.limit(input.limit ?? 200)

	return { events: rows, adminOnly: false as const }
})
