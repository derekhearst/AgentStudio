import {
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	real,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { chatRuns } from '$lib/runs/runs.schema'
import { agents } from '$lib/agents/agents.schema'

/**
 * Wave 3 #14 phase 1+2 — evaluation framework schema.
 *
 * `run_evaluations` records the verdict + findings + cost from one evaluator pass against a
 * generator run. The full re-plan loop (Phase 3) reads these rows to decide whether to spawn
 * a retry; the task-level integration (Phase 4) reads them to gate a task's transition to
 * `completed`. This phase ships the schema + recorder; integration follows.
 */

export const evaluationVerdictEnum = pgEnum('evaluation_verdict', ['pass', 'fail', 'needs_revision'])

export type EvaluationFinding = {
	severity: 'info' | 'warning' | 'error'
	category?: string
	message: string
	path?: string
	suggestion?: string
}

export const runEvaluations = pgTable(
	'run_evaluations',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// The generator run being evaluated. Cascade so deleting the source run trims its evals.
		runId: uuid('run_id')
			.notNull()
			.references(() => chatRuns.id, { onDelete: 'cascade' }),
		// The evaluator's own chat_run row (if it ran as a real agent — Phase 2 stub may insert
		// rows without an evaluatorRunId for synthetic verdicts during testing). Set-null on
		// delete so the verdict survives even if the evaluator run is GC'd later.
		evaluatorRunId: uuid('evaluator_run_id').references(() => chatRuns.id, { onDelete: 'set null' }),
		// Which evaluator agent produced this verdict. Set-null on agent delete.
		evaluatorAgentId: uuid('evaluator_agent_id').references(() => agents.id, { onDelete: 'set null' }),
		verdict: evaluationVerdictEnum('verdict').notNull(),
		findings: jsonb('findings').$type<EvaluationFinding[]>().notNull().default([]),
		// 0..1 confidence score. Real (float) since exact precision doesn't matter here.
		confidence: real('confidence'),
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
		// Free-form metadata — provider, model, evaluation prompt template, anything the
		// evaluator wants to record alongside the verdict.
		metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		runIdx: index('run_evaluations_run_idx').on(table.runId),
		evaluatorAgentIdx: index('run_evaluations_evaluator_agent_idx').on(table.evaluatorAgentId),
		verdictIdx: index('run_evaluations_verdict_idx').on(table.verdict),
		createdIdx: index('run_evaluations_created_idx').on(table.createdAt),
	}),
)

export type RunEvaluationRow = typeof runEvaluations.$inferSelect
export type EvaluationVerdict = (typeof evaluationVerdictEnum.enumValues)[number]
