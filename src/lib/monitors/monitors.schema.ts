import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'
import { agents } from '$lib/agents/agents.schema'
import type { MonitorAction, MonitorActionConfig, MonitorCondition, MonitorObservation } from './condition'

/**
 * #33 — long-horizon monitors.
 *
 * An automation answers "run this every N". A monitor answers "watch for X and act when it
 * happens": a stored condition, a check interval, a deadline, and an action. The durable job
 * queue does the waking (`monitors_dispatch` → `monitor_check`), this table holds the standing
 * intent plus the state that makes "changed since last check" and "fire once per change" work.
 *
 * Lifecycle (`status`):
 *   active    — being checked on `nextCheckAt`
 *   paused    — operator paused it; the dispatcher skips it, the deadline still applies
 *   fired     — one-shot monitor fired and retired (terminal)
 *   expired   — `deadlineAt` passed (terminal). EVERY monitor has a deadline; see below.
 *   exhausted — `checkCount` reached `maxChecks` (terminal). The cost cap, not the clock.
 *   failed    — `consecutiveErrors` blew the error budget (terminal)
 *   canceled  — operator canceled (terminal)
 *
 * Why two caps: the deadline bounds wall-clock lifetime, `maxChecks` bounds spend. A
 * 30-day monitor on a 60-second interval is 43,200 checks — if each one is a model call,
 * that is a bill. Neither cap alone is enough, so a monitor carries both and dies on
 * whichever it hits first. Extension is explicit (`extendMonitor`) and re-capped.
 *
 * Debounce: `conditionMet` is an edge-trigger latch. The action runs on the false→true
 * transition only; while the condition stays true the monitor is quiet, and it re-arms when
 * the condition goes false again. A one-shot monitor never gets a second edge — it retires
 * on the first.
 */

export const monitorStatusEnum = pgEnum('monitor_status', [
	'active',
	'paused',
	'fired',
	'expired',
	'exhausted',
	'failed',
	'canceled',
])

/**
 * How the condition is observed.
 *
 *   tool_result   — run a read-only tool call and compare the (optionally extracted) result
 *                   against the last observation. Free apart from whatever the tool costs.
 *   model_question — fetch context, then ask a cheap model a yes/no question about it. This
 *                   is the path that makes monitors general, and the path that quietly
 *                   spends money, so it goes through the budget gate on every check.
 */
export const monitorConditionKindEnum = pgEnum('monitor_condition_kind', ['tool_result', 'model_question'])

/** What happens on the firing edge. */
export const monitorActionEnum = pgEnum('monitor_action', [
	'start_conversation',
	'review_item',
	'push',
	'run_automation',
])

export const monitors = pgTable(
	'monitors',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** Optional agent attribution — used for agent-scoped budget limits and as the
		 *  conversation's agent when the action is `start_conversation`. */
		agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
		/** Short human label. Shown on /monitors and in the fired review item / push. */
		name: text('name').notNull(),
		status: monitorStatusEnum('status').notNull().default('active'),

		conditionKind: monitorConditionKindEnum('condition_kind').notNull(),
		/** Discriminated on `kind`; validated by `monitorConditionSchema` before every write. */
		condition: jsonb('condition').$type<MonitorCondition>().notNull(),

		action: monitorActionEnum('action').notNull(),
		actionConfig: jsonb('action_config').$type<MonitorActionConfig>().notNull().default({}),

		/** Seconds between checks. Floor of 60s so a monitor can never become a busy loop. */
		intervalSeconds: integer('interval_seconds').notNull().default(900),
		/** Hard stop. Never null — a monitor with no deadline is a memory leak with a bill. */
		deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
		/** Spend cap, counted in checks actually performed. */
		maxChecks: integer('max_checks').notNull().default(200),
		checkCount: integer('check_count').notNull().default(0),

		nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
		lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
		/** The state that powers "changed since last check" and the UI's "watching" column. */
		lastObservation: jsonb('last_observation').$type<MonitorObservation>(),
		/** Edge-trigger latch — see the debounce note above. */
		conditionMet: boolean('condition_met').notNull().default(false),

		fireCount: integer('fire_count').notNull().default(0),
		lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
		/** Outcome of the last action dispatch, e.g. {kind:'review_item', reviewItemId}. */
		lastFireResult: jsonb('last_fire_result').$type<Record<string, unknown>>(),

		consecutiveErrors: integer('consecutive_errors').notNull().default(0),
		lastError: text('last_error'),

		/** Retire on the first fire. False keeps watching for the next edge until a cap hits. */
		oneShot: boolean('one_shot').notNull().default(true),

		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => ({
		// The dispatcher's only query path: active monitors whose next check is due.
		dueIdx: index('monitors_due_idx').on(t.status, t.nextCheckAt),
		userIdx: index('monitors_user_idx').on(t.userId),
		deadlineIdx: index('monitors_deadline_idx').on(t.deadlineAt),
	}),
)

export type MonitorRow = typeof monitors.$inferSelect
export type MonitorStatus = (typeof monitorStatusEnum.enumValues)[number]
export type MonitorConditionKind = (typeof monitorConditionKindEnum.enumValues)[number]
export type MonitorActionName = MonitorAction
