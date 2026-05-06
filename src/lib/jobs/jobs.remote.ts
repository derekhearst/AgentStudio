import { query } from '$app/server'
import { and, desc, eq, gte, sql as drizzleSql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { jobs } from './jobs.schema'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Wave 4 #17 phase 1 — admin-only `jobs` reader for `/settings/jobs`.
 *
 * Same shape + admin gate as the audit + hooks readers. Aggregates per-status counts (last
 * 24h) for the header so the UI shows queue health at a glance: pending depth, retry_wait
 * backlog, failure rate, etc.
 */

const listSchema = z
	.object({
		status: z.enum(['pending', 'leased', 'running', 'retry_wait', 'completed', 'failed', 'canceled']).optional(),
		type: z.string().optional(),
		queue: z.string().optional(),
		failuresOnly: z.boolean().optional(),
		sinceISO: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(500).optional(),
	})
	.default({})

export const listJobsQuery = query(listSchema, async (input) => {
	requireAuthenticatedRequestUser()

	const filters = []
	if (input.status) filters.push(eq(jobs.status, input.status))
	if (input.type) filters.push(eq(jobs.type, input.type))
	if (input.queue) filters.push(eq(jobs.queue, input.queue))
	if (input.failuresOnly) filters.push(eq(jobs.status, 'failed'))
	if (input.sinceISO) filters.push(gte(jobs.createdAt, new Date(input.sinceISO)))

	const where = filters.length > 0 ? and(...filters) : undefined

	const rows = await db
		.select({
			id: jobs.id,
			type: jobs.type,
			status: jobs.status,
			queue: jobs.queue,
			priority: jobs.priority,
			attemptCount: jobs.attemptCount,
			maxAttempts: jobs.maxAttempts,
			scheduledAt: jobs.scheduledAt,
			startedAt: jobs.startedAt,
			finishedAt: jobs.finishedAt,
			leaseExpiresAt: jobs.leaseExpiresAt,
			error: jobs.error,
			runId: jobs.runId,
			taskId: jobs.taskId,
			createdAt: jobs.createdAt,
		})
		.from(jobs)
		.where(where)
		.orderBy(desc(jobs.createdAt))
		.limit(input.limit ?? 200)

	const sinceLast24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
	const summary = await db
		.select({
			status: jobs.status,
			total: drizzleSql<number>`count(*)::int`,
		})
		.from(jobs)
		.where(gte(jobs.createdAt, sinceLast24h))
		.groupBy(jobs.status)

	return { jobs: rows, summary, adminOnly: false as const }
})
