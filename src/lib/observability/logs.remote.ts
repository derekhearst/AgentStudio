import { query } from '$app/server'
import { z } from 'zod'
import { listAppLogs, countLogsBySource, type ListAppLogsFilters } from './logs.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

const listSchema = z
	.object({
		level: z.enum(LEVELS).optional(),
		minLevel: z.enum(LEVELS).optional(),
		source: z.string().trim().min(1).max(80).optional(),
		search: z.string().trim().min(1).max(200).optional(),
		sinceISO: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(1000).optional(),
	})
	.default({})

export const listAppLogsQuery = query(listSchema, async (input) => {
	requireAuthenticatedRequestUser()
	const filters: ListAppLogsFilters = {
		level: input.level,
		minLevel: input.minLevel,
		source: input.source,
		search: input.search,
		sinceISO: input.sinceISO,
		limit: input.limit,
	}
	const { logs } = await listAppLogs(filters)
	return { logs }
})

const countSchema = z
	.object({
		windowMinutes: z.number().int().min(1).max(60 * 24 * 30).default(60),
	})
	.default({ windowMinutes: 60 })

export const countLogsBySourceQuery = query(countSchema, async ({ windowMinutes }) => {
	requireAuthenticatedRequestUser()
	const counts = await countLogsBySource(windowMinutes * 60 * 1000)
	return { windowMinutes, counts }
})
