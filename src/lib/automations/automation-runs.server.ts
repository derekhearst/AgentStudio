import { and, desc, eq, gte, inArray, lt, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	automationRuns,
	automations,
	type AutomationRunRow,
	type AutomationRunStatus,
	type AutomationRunTrigger,
} from '$lib/automations/automation.schema'
import { logger } from '$lib/observability/logger'
import { AUTOMATION_RUN_RETENTION_DAYS, toOutputExcerpt } from './failure-policy'

/**
 * #31 — the automation run ledger.
 *
 * Every attempt at executing an automation opens a row here (status `running`) and closes
 * it (`completed` / `failed` / `blocked`) when the attempt ends. Writes are best-effort:
 * a ledger hiccup must never take down the run it is describing, so every function here
 * swallows its own errors and returns null rather than throwing into the engine.
 */

export type StartAutomationRunInput = {
	automationId: string
	userId: string | null
	mode: string
	trigger: AutomationRunTrigger
	attempt: number
	jobId?: string | null
	startedAt?: Date
}

export async function startAutomationRun(input: StartAutomationRunInput): Promise<AutomationRunRow | null> {
	try {
		const [row] = await db
			.insert(automationRuns)
			.values({
				automationId: input.automationId,
				userId: input.userId ?? null,
				status: 'running',
				trigger: input.trigger,
				attempt: Math.max(1, Math.floor(input.attempt)),
				mode: input.mode,
				jobId: input.jobId ?? null,
				startedAt: input.startedAt ?? new Date(),
			})
			.returning()
		return row ?? null
	} catch (err) {
		logger.warn('[automations] startAutomationRun failed (non-fatal)', { err })
		return null
	}
}

export type FinishAutomationRunInput = {
	status: AutomationRunStatus
	conversationId?: string | null
	chatRunId?: string | null
	researchId?: string | null
	costUsd?: string | number | null
	error?: string | null
	output?: unknown
	finishedAt?: Date
}

export async function finishAutomationRun(
	runRowId: string | null | undefined,
	input: FinishAutomationRunInput,
): Promise<void> {
	if (!runRowId) return
	try {
		const finishedAt = input.finishedAt ?? new Date()
		const [existing] = await db
			.select({ startedAt: automationRuns.startedAt })
			.from(automationRuns)
			.where(eq(automationRuns.id, runRowId))
			.limit(1)
		const durationMs = existing?.startedAt
			? Math.max(0, finishedAt.getTime() - existing.startedAt.getTime())
			: null

		await db
			.update(automationRuns)
			.set({
				status: input.status,
				finishedAt,
				durationMs,
				conversationId: input.conversationId ?? null,
				chatRunId: input.chatRunId ?? null,
				researchId: input.researchId ?? null,
				costUsd: normalizeCost(input.costUsd),
				error: input.error ? input.error.slice(0, 4000) : null,
				outputExcerpt: toOutputExcerpt(input.output),
			})
			.where(eq(automationRuns.id, runRowId))
	} catch (err) {
		logger.warn('[automations] finishAutomationRun failed (non-fatal)', { err })
	}
}

function normalizeCost(value: string | number | null | undefined): string | null {
	if (value === null || value === undefined) return null
	const numeric = typeof value === 'number' ? value : Number.parseFloat(value)
	if (!Number.isFinite(numeric) || numeric <= 0) return null
	return numeric.toFixed(12)
}

/**
 * Run history for one automation, newest first. Scoped through the owning automation so a
 * user can never read another user's ledger by guessing an id.
 */
export async function listAutomationRunsForUser(
	userId: string,
	opts: { automationId: string; limit?: number },
): Promise<AutomationRunRow[]> {
	const [owned] = await db
		.select({ id: automations.id })
		.from(automations)
		.where(and(eq(automations.id, opts.automationId), eq(automations.userId, userId)))
		.limit(1)
	if (!owned) return []

	return db
		.select()
		.from(automationRuns)
		.where(eq(automationRuns.automationId, opts.automationId))
		.orderBy(desc(automationRuns.startedAt))
		.limit(Math.min(Math.max(opts.limit ?? 20, 1), 100))
}

export type AutomationRunSummary = {
	automationId: string
	status: AutomationRunStatus
	trigger: AutomationRunTrigger
	startedAt: Date
	finishedAt: Date | null
	error: string | null
	conversationId: string | null
	researchId: string | null
	failures24h: number
}

/**
 * Latest run per automation plus a 24h failure count, in two queries whatever the number of
 * automations. Feeds the status strip on each card so the list page doesn't need a query
 * per row.
 *
 * Both are computed per automation in the database. They used to be derived from the 500
 * newest runs across ALL of the user's automations, so one automation running every minute
 * filled that slice within hours and every other card lost its last-run badge and its
 * failures — the daily job that failed this morning looked fine by the evening.
 */
export async function getLatestRunSummaries(
	automationIds: string[],
	now = new Date(),
): Promise<Map<string, AutomationRunSummary>> {
	const summaries = new Map<string, AutomationRunSummary>()
	if (automationIds.length === 0) return summaries

	try {
		const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
		const [latest, failures] = await Promise.all([
			// One row per automation: its newest run (served by automation_runs_automation_idx).
			db
				.selectDistinctOn([automationRuns.automationId])
				.from(automationRuns)
				.where(inArray(automationRuns.automationId, automationIds))
				.orderBy(automationRuns.automationId, desc(automationRuns.startedAt)),
			db
				.select({
					automationId: automationRuns.automationId,
					count: drizzleSql<number>`count(*)::int`,
				})
				.from(automationRuns)
				.where(
					and(
						inArray(automationRuns.automationId, automationIds),
						eq(automationRuns.status, 'failed'),
						gte(automationRuns.startedAt, cutoff),
					),
				)
				.groupBy(automationRuns.automationId),
		])

		const failureCounts = new Map(failures.map((row) => [row.automationId, Number(row.count)]))
		for (const row of latest) {
			summaries.set(row.automationId, {
				automationId: row.automationId,
				status: row.status,
				trigger: row.trigger,
				startedAt: row.startedAt,
				finishedAt: row.finishedAt,
				error: row.error,
				conversationId: row.conversationId,
				researchId: row.researchId,
				failures24h: failureCounts.get(row.automationId) ?? 0,
			})
		}
	} catch (err) {
		logger.warn('[automations] getLatestRunSummaries failed (non-fatal)', { err })
	}

	return summaries
}

/**
 * Age-based retention. The ledger is an operational aid, not an audit log — a year of
 * per-minute ticks would be millions of rows nobody reads. Called from the dispatch tick.
 */
export async function pruneAutomationRuns(
	olderThanDays = AUTOMATION_RUN_RETENTION_DAYS,
	now = new Date(),
): Promise<number> {
	try {
		const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000)
		const deleted = await db
			.delete(automationRuns)
			.where(lt(automationRuns.startedAt, cutoff))
			.returning({ id: automationRuns.id })
		return deleted.length
	} catch (err) {
		logger.warn('[automations] pruneAutomationRuns failed (non-fatal)', { err })
		return 0
	}
}

/**
 * Reap ledger rows left in `running` by a process that died mid-tick. Without this a
 * crashed worker leaves a row that claims the automation is still executing forever.
 */
export async function reapStalledAutomationRuns(stalledAfterMs = 30 * 60 * 1000, now = new Date()): Promise<number> {
	try {
		const cutoff = new Date(now.getTime() - stalledAfterMs)
		const reaped = await db
			.update(automationRuns)
			.set({
				status: 'failed',
				finishedAt: now,
				error: 'Run never reported a result — the worker process likely restarted mid-tick.',
			})
			.where(and(eq(automationRuns.status, 'running'), lt(automationRuns.startedAt, cutoff)))
			.returning({ id: automationRuns.id })
		return reaped.length
	} catch (err) {
		logger.warn('[automations] reapStalledAutomationRuns failed (non-fatal)', { err })
		return 0
	}
}

/** Failure-streak bookkeeping lives next to the ledger it is derived from. */
export async function resetAutomationFailureState(automationId: string): Promise<void> {
	try {
		await db
			.update(automations)
			.set({ consecutiveFailures: 0, disabledReason: null })
			.where(
				and(
					eq(automations.id, automationId),
					drizzleSql`(${automations.consecutiveFailures} > 0 or ${automations.disabledReason} is not null)`,
				),
			)
	} catch (err) {
		logger.warn('[automations] resetAutomationFailureState failed (non-fatal)', { err })
	}
}
