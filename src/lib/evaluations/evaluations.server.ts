import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	runEvaluations,
	type EvaluationFinding,
	type EvaluationVerdict,
	type RunEvaluationRow,
} from './evaluations.schema'

/**
 * Wave 3 #14 phase 1+2 — evaluation recorder.
 *
 * Insert + read helpers for run_evaluations. Phase 3+ will add the actual evaluator-spawn
 * orchestration; this slice ships the durable-record half so the schema, indexes, and
 * downstream UI surfaces (run viewer, task gating) can land first.
 */

export type RecordEvaluationInput = {
	runId: string
	verdict: EvaluationVerdict
	findings?: EvaluationFinding[]
	confidence?: number | null
	costUsd?: number | string | null
	evaluatorRunId?: string | null
	evaluatorAgentId?: string | null
	metadata?: Record<string, unknown>
}

export async function recordEvaluation(input: RecordEvaluationInput): Promise<RunEvaluationRow> {
	const [row] = await db
		.insert(runEvaluations)
		.values({
			runId: input.runId,
			verdict: input.verdict,
			findings: input.findings ?? [],
			confidence: input.confidence ?? null,
			costUsd: input.costUsd != null ? String(input.costUsd) : null,
			evaluatorRunId: input.evaluatorRunId ?? null,
			evaluatorAgentId: input.evaluatorAgentId ?? null,
			metadata: input.metadata ?? {},
		})
		.returning()
	return row
}

/** All evaluations for a run, oldest first (so the UI can show the verdict trajectory). */
export async function listEvaluationsForRun(runId: string): Promise<RunEvaluationRow[]> {
	return db
		.select()
		.from(runEvaluations)
		.where(eq(runEvaluations.runId, runId))
		.orderBy(asc(runEvaluations.createdAt))
}

/** Latest verdict for a run, or null if no evaluation has fired yet. */
export async function getLatestEvaluationForRun(runId: string): Promise<RunEvaluationRow | null> {
	const rows = await listEvaluationsForRun(runId)
	if (rows.length === 0) return null
	return rows[rows.length - 1]
}

/**
 * Phase 4 helper: determine whether a run is "evaluation-clear" — either no evaluation was
 * required, or the most recent one is `pass`. Used by the task-completion gate (a task with
 * `evalRequired = true` only transitions to `completed` when this returns true).
 */
export async function isRunEvaluationClear(runId: string): Promise<boolean> {
	const [run] = await db
		.select()
		.from((await import('$lib/runs/runs.schema')).chatRuns)
		.where(eq((await import('$lib/runs/runs.schema')).chatRuns.id, runId))
		.limit(1)
	if (!run) return false
	if (!run.evalRequired) return true
	const latest = await getLatestEvaluationForRun(runId)
	return latest?.verdict === 'pass'
}

/**
 * Aggregate finding counts by severity for the run viewer's at-a-glance summary.
 */
export async function summarizeFindingsForRun(runId: string): Promise<{
	totalEvaluations: number
	latestVerdict: EvaluationVerdict | null
	findings: { info: number; warning: number; error: number }
}> {
	const rows = await listEvaluationsForRun(runId)
	const summary = { info: 0, warning: 0, error: 0 }
	for (const r of rows) {
		for (const f of r.findings ?? []) {
			summary[f.severity]++
		}
	}
	return {
		totalEvaluations: rows.length,
		latestVerdict: rows.length > 0 ? rows[rows.length - 1].verdict : null,
		findings: summary,
	}
}
// `and` import kept tree-shakeable for future helpers; reference once to silence the linter.
void and
