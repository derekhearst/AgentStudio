import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { chatRuns } from '$lib/runs/runs.schema'

/**
 * Wave 3 #13 phase 1 — hook invocation log.
 *
 * Every dispatched hook (built-in OR skill-based) records one row here so the admin can audit
 * what fired when, how long it took, and whether it errored. Failures don't block the run —
 * they're isolated and logged here for forensic visibility.
 */

export const hookKindEnum = pgEnum('hook_kind', ['builtin', 'skill'])

export const hookInvocations = pgTable(
	'hook_invocations',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Run this hook fired against. Cascade so deleting a run trims its hook trail too.
		// Nullable for hooks fired outside a run context (future: scheduled hooks, etc.).
		runId: uuid('run_id').references(() => chatRuns.id, { onDelete: 'cascade' }),
		event: text('event').notNull(),
		hookKind: hookKindEnum('hook_kind').notNull(),
		// Built-in: the registered fn name. Skill-based: the skill slug.
		hookRef: text('hook_ref').notNull(),
		success: boolean('success').notNull(),
		durationMs: integer('duration_ms').notNull(),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		runIdx: index('hook_invocations_run_idx').on(table.runId),
		eventIdx: index('hook_invocations_event_idx').on(table.event),
		successIdx: index('hook_invocations_success_idx').on(table.success),
		createdIdx: index('hook_invocations_created_idx').on(table.createdAt),
	}),
)

export type HookInvocationRow = typeof hookInvocations.$inferSelect
