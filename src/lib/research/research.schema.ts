import {
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 4 #18 phase 1 — research domain schema.
 *
 * Three tables for evidence-gathered, cited research:
 *
 *   research — the top-level research run. One row per Deep Research request.
 *   researchSources — every URL/PDF read; cites which step found them and whether the final
 *                     report cites them.
 *   researchSteps — the search→fetch→synthesize trace. One row per atomic step.
 *
 * Lifecycle:
 *   planning → searching → fetching → synthesizing → complete (or → failed/canceled)
 *
 * The full search→fetch→synthesize loop runs in a `research` job (Phase 3) that the chat
 * handler enqueues when a "Deep Research" toggle is set. This phase ships only the durable
 * data model + the `web_fetch` tool that Phase 2's loop will use.
 */

export const researchStatusEnum = pgEnum('research_status', [
	'planning',
	'searching',
	'fetching',
	'synthesizing',
	'complete',
	'failed',
	'canceled',
])

export const researchStepKindEnum = pgEnum('research_step_kind', [
	'plan',
	'search',
	'fetch',
	'extract',
	'synthesize',
	'note',
])

export const research = pgTable(
	'research',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
		// Cross-domain pointers — declared by-name to avoid circular imports.
		conversationId: uuid('conversation_id'),
		runId: uuid('run_id'),
		jobId: uuid('job_id'),
		query: text('query').notNull(),
		status: researchStatusEnum('status').notNull().default('planning'),
		// Sub-questions parsed from the user's query (one per planned investigation thread).
		plan: jsonb('plan').$type<string[]>().notNull().default([]),
		// Final synthesized report — markdown with inline [N] citations resolved against
		// researchSources. Null until status='complete'.
		report: text('report'),
		// Cumulative LLM + tool spend for this research run.
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }).notNull().default('0'),
		tokensUsed: integer('tokens_used').notNull().default(0),
		startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		userIdx: index('research_user_idx').on(t.userId),
		statusIdx: index('research_status_idx').on(t.status),
		conversationIdx: index('research_conversation_idx').on(t.conversationId),
		jobIdx: index('research_job_idx').on(t.jobId),
		createdIdx: index('research_created_idx').on(t.createdAt),
	}),
)

export const researchSources = pgTable(
	'research_sources',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		researchId: uuid('research_id')
			.notNull()
			.references(() => research.id, { onDelete: 'cascade' }),
		url: text('url').notNull(),
		title: text('title'),
		// Truncated extracted text (50k char cap per fetch). Full content stored in workspace if
		// archived; this column is what the synthesis stage reasons over.
		extractedText: text('extracted_text'),
		contentType: text('content_type').notNull().default('html'),
		fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
		// True once the synthesis stage decides this source contributed to the final report.
		// Set in a single update at the end of synthesis when the model emits citation indices.
		citedInReport: boolean('cited_in_report').notNull().default(false),
		// Optional per-source notes the orchestrator extracted (relevant passages, judgments).
		notes: text('notes'),
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
	},
	(t) => ({
		researchIdx: index('research_sources_research_idx').on(t.researchId),
		citedIdx: index('research_sources_cited_idx').on(t.citedInReport),
	}),
)

export const researchSteps = pgTable(
	'research_steps',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		researchId: uuid('research_id')
			.notNull()
			.references(() => research.id, { onDelete: 'cascade' }),
		seq: integer('seq').notNull(),
		kind: researchStepKindEnum('kind').notNull(),
		// Sub-question this step is investigating (null for top-level plan + final synthesis).
		subQuestion: text('sub_question'),
		// Free-form payload — varies by kind:
		//   - plan: { subQuestions: string[] }
		//   - search: { query: string, results: SearchResult[] }
		//   - fetch: { url: string, sourceId: string }
		//   - extract: { sourceId: string, passages: string[] }
		//   - synthesize: { partial: string }
		//   - note: { message: string }
		payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
		// LLM cost for this single step (when applicable — search/fetch are zero-LLM).
		costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
		startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		error: text('error'),
	},
	(t) => ({
		researchIdx: index('research_steps_research_idx').on(t.researchId),
		seqIdx: index('research_steps_seq_idx').on(t.researchId, t.seq),
		kindIdx: index('research_steps_kind_idx').on(t.kind),
	}),
)

export type ResearchRow = typeof research.$inferSelect
export type ResearchSourceRow = typeof researchSources.$inferSelect
export type ResearchStepRow = typeof researchSteps.$inferSelect
export type ResearchStatus = (typeof researchStatusEnum.enumValues)[number]
export type ResearchStepKind = (typeof researchStepKindEnum.enumValues)[number]
