import { query } from '$app/server'
import { and, desc, eq, gte, sql as drizzleSql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { hookInvocations } from './hooks.schema'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Wave 3 #13 phase 5 — admin-only `hook_invocations` reader for `/settings/hooks`.
 *
 * Same shape + admin gate as the audit reader. Aggregates per-event success/failure counts
 * for the header summary so the UI doesn't have to roll them up client-side.
 *
 * Hard-cap of 500 rows; the bus is fire-and-forget so this table grows fast on a busy run
 * and we don't want a runaway page load. Future work could add cursor pagination + retention.
 */

const listSchema = z
	.object({
		event: z.string().optional(),
		hookKind: z.enum(['builtin', 'skill']).optional(),
		successOnly: z.boolean().optional(),
		failuresOnly: z.boolean().optional(),
		runId: z.string().uuid().optional(),
		sinceISO: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(500).optional(),
	})
	.default({})

export const listHookInvocationsQuery = query(listSchema, async (input) => {
	requireAuthenticatedRequestUser()

	const filters = []
	if (input.event) filters.push(eq(hookInvocations.event, input.event))
	if (input.hookKind) filters.push(eq(hookInvocations.hookKind, input.hookKind))
	if (input.successOnly) filters.push(eq(hookInvocations.success, true))
	if (input.failuresOnly) filters.push(eq(hookInvocations.success, false))
	if (input.runId) filters.push(eq(hookInvocations.runId, input.runId))
	if (input.sinceISO) filters.push(gte(hookInvocations.createdAt, new Date(input.sinceISO)))

	const where = filters.length > 0 ? and(...filters) : undefined

	// Wrap both queries in a try/catch so a missing-table or aggregate-cast failure on a
	// freshly-deployed environment degrades to an empty list with an explanatory error
	// instead of a generic "Internal Error" 500 that hides the root cause from the user.
	try {
		const invocations = await db
			.select({
				id: hookInvocations.id,
				runId: hookInvocations.runId,
				event: hookInvocations.event,
				hookKind: hookInvocations.hookKind,
				hookRef: hookInvocations.hookRef,
				success: hookInvocations.success,
				durationMs: hookInvocations.durationMs,
				error: hookInvocations.error,
				createdAt: hookInvocations.createdAt,
			})
			.from(hookInvocations)
			.where(where)
			.orderBy(desc(hookInvocations.createdAt))
			.limit(input.limit ?? 200)

		// Per-event rollup — last 24h, ignoring filters so the header always shows the global health.
		// COALESCE around aggregates so empty groups + null casts don't blow up.
		const sinceLast24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
		const summary = await db
			.select({
				event: hookInvocations.event,
				total: drizzleSql<number>`coalesce(count(*), 0)::int`,
				failures: drizzleSql<number>`coalesce(sum(case when ${hookInvocations.success} then 0 else 1 end), 0)::int`,
				avgDurationMs: drizzleSql<number>`coalesce(avg(${hookInvocations.durationMs})::int, 0)`,
			})
			.from(hookInvocations)
			.where(gte(hookInvocations.createdAt, sinceLast24h))
			.groupBy(hookInvocations.event)
			.orderBy(desc(drizzleSql`count(*)`))

		return { invocations, summary, adminOnly: false as const }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error('[hooks/listHookInvocationsQuery] DB error:', message)
		return {
			invocations: [],
			summary: [],
			adminOnly: false as const,
			loadError: `Could not load hook invocations: ${message}`,
		}
	}
})
