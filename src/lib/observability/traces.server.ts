import { eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { runTraces, type RunTraceRow, type RunTraceStatus } from './observability.schema'
import { logger } from './logger'

/**
 * Wave 5 #20 phase 2 — run-trace span recording.
 *
 * Lightweight append-on-event API for the runtime + jobs:
 *   - `startRunTrace({runId, sessionId?, jobId?})` upserts a row in `running` state
 *   - `appendTraceSpan({runId, span})` pushes a span object onto the trace jsonb array
 *   - `finishRunTrace({runId, status, costUsd?})` flips the row to terminal + records cost
 *
 * The trace shape is intentionally loose — each span is a `{seq, kind, ...rest}` object that
 * the trace viewer parses into a timeline. The runtime currently emits these kinds:
 *   - 'round_start' / 'round_end' — one pair per LLM round
 *   - 'tool_call' — per tool invocation, with toolName, durationMs, success
 *   - 'compaction' — when context compaction fires
 *   - 'approval' — pending approval / decision events
 *   - 'subagent' — sub-agent dispatch
 *
 * Best-effort: a thrown DB error never blocks the runtime loop. Trace gaps are acceptable —
 * the run still completes durably via run_events.
 */

export type TraceSpan = {
	seq: number
	kind: string
	startedAt: string // ISO
	durationMs?: number
	success?: boolean
	[key: string]: unknown
}

export type StartRunTraceInput = {
	runId: string
	sessionId?: string | null
	jobId?: string | null
}

export async function startRunTrace(input: StartRunTraceInput): Promise<RunTraceRow | null> {
	try {
		// Upsert: if a trace already exists for this runId (resume case), keep it.
		const [existing] = await db.select().from(runTraces).where(eq(runTraces.runId, input.runId)).limit(1)
		if (existing) return existing
		const [row] = await db
			.insert(runTraces)
			.values({
				runId: input.runId,
				sessionId: input.sessionId ?? null,
				jobId: input.jobId ?? null,
				status: 'running',
				trace: [],
			})
			.returning()
		return row
	} catch (err) {
		logger.warn('[traces] startRunTrace failed (non-fatal)', { err })
		return null
	}
}

export async function appendTraceSpan(runId: string, span: Omit<TraceSpan, 'seq'>): Promise<void> {
	try {
		// Use jsonb array append — `trace || ${jsonb}` so we don't have to read+rewrite.
		// Auto-assign seq via array length at append time.
		const next = {
			...span,
			seq: 0, // placeholder; the SQL assigns via jsonb_array_length
		}
		await db
			.update(runTraces)
			.set({
				trace: drizzleSql`${runTraces.trace} || jsonb_build_array(jsonb_set(${JSON.stringify(next)}::jsonb, '{seq}', to_jsonb(jsonb_array_length(${runTraces.trace}))))`,
				updatedAt: new Date(),
				toolCallCount: span.kind === 'tool_call'
					? drizzleSql`${runTraces.toolCallCount} + 1`
					: runTraces.toolCallCount,
				roundCount: span.kind === 'round_start'
					? drizzleSql`${runTraces.roundCount} + 1`
					: runTraces.roundCount,
			})
			.where(eq(runTraces.runId, runId))
	} catch (err) {
		logger.warn('[traces] appendTraceSpan failed (non-fatal)', { err })
	}
}

export type FinishRunTraceInput = {
	runId: string
	status: Exclude<RunTraceStatus, 'running'>
	costUsd?: number | string
}

export async function finishRunTrace(input: FinishRunTraceInput): Promise<RunTraceRow | null> {
	try {
		const [row] = await db
			.update(runTraces)
			.set({
				status: input.status,
				finishedAt: new Date(),
				costUsd: input.costUsd != null ? String(input.costUsd) : undefined,
				updatedAt: new Date(),
			})
			.where(eq(runTraces.runId, input.runId))
			.returning()
		return row ?? null
	} catch (err) {
		logger.warn('[traces] finishRunTrace failed (non-fatal)', { err })
		return null
	}
}

export async function getRunTraceByRunId(runId: string): Promise<RunTraceRow | null> {
	const [row] = await db.select().from(runTraces).where(eq(runTraces.runId, runId)).limit(1)
	return row ?? null
}

export type RecentFailure = {
	runId: string
	kind: 'run_failed' | 'tool_failed'
	label: string
	occurredAt: Date
	costUsd: string | null
}

/**
 * Pull recent run/tool failures for the consolidated /review dashboard. Returns one row per
 * run that ended `failed` plus one row per failed tool span. Ordered by occurredAt desc,
 * capped to `limit`.
 *
 * Run-level failures come from `chat_runs`, the record every run path writes its terminal
 * state to (and what the KPI strip's `runs.failed_24h` counts). They used to come from
 * `run_traces`, which only the legacy runtime loop writes and which never recorded
 * `failed`, so the panel said "No failures" beside a KPI showing them. The label is the
 * run's error, and the cost is what the ledger holds for the run.
 *
 * Tool-call failures still come from trace spans (the only place a per-call `success` is
 * kept) and use the span's `startedAt`.
 */
export async function listRecentFailures(hours = 24, limit = 20): Promise<RecentFailure[]> {
	const rows = await db.execute<{
		run_id: string
		kind: 'run_failed' | 'tool_failed'
		label: string
		occurred_at: string
		cost_usd: string | null
	}>(drizzleSql`
		with run_level as (
			select
				cr.id as run_id,
				'run_failed'::text as kind,
				coalesce(nullif(btrim(left(split_part(cr.error, chr(10), 1), 200)), ''), 'Run failed')::text as label,
				coalesce(cr.finished_at, cr.updated_at) as occurred_at,
				round(
					coalesce((select sum(lu.cost) from llm_usage lu where lu.run_id = cr.id), 0)
					+ coalesce((select sum(tu.cost) from tool_usage tu where tu.run_id = cr.id), 0),
					6
				)::text as cost_usd
			from chat_runs cr
			where cr.state = 'failed'
				and coalesce(cr.finished_at, cr.updated_at) >= now() - (${hours}::int * interval '1 hour')
		),
		trace_window as (
			select run_id, finished_at, updated_at, cost_usd, trace
			from run_traces
			where coalesce(finished_at, updated_at) >= now() - (${hours}::int * interval '1 hour')
		),
		tool_level as (
			select
				tw.run_id,
				'tool_failed'::text as kind,
				coalesce(span->>'toolName', span->>'kind', 'tool')::text as label,
				coalesce(
					(span->>'startedAt')::timestamptz,
					tw.finished_at,
					tw.updated_at
				) as occurred_at,
				tw.cost_usd::text as cost_usd
			from trace_window tw,
				lateral jsonb_array_elements(tw.trace) as span
			where span->>'kind' = 'tool_call' and (span->>'success')::boolean is false
		)
		select * from run_level
		union all
		select * from tool_level
		order by occurred_at desc
		limit ${limit}
	`)
	return (rows as unknown as Array<{
		run_id: string
		kind: 'run_failed' | 'tool_failed'
		label: string
		occurred_at: string | Date
		cost_usd: string | null
	}>).map((r) => ({
		runId: r.run_id,
		kind: r.kind,
		label: r.label,
		occurredAt: new Date(r.occurred_at),
		costUsd: r.cost_usd,
	}))
}
