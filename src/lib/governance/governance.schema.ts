import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from '$lib/auth/auth.schema'

/**
 * Wave 3 #12 phase 1 — governance audit log.
 *
 * Distinct from `activity_events` (which is the user-facing activity feed) — this is the
 * compliance / forensic trail for sensitive write paths: settings changes, agent config
 * changes, budget limit CRUD, capability binding flips. Read-only after insert; the dashboard
 * + admin-only `/audit` page surface this for review.
 *
 * Each row captures who did what, to what, when, and (when relevant) the before/after state
 * snapshots so a reviewer can see the actual delta without having to reconstruct it.
 */

export const auditActionEnum = pgEnum('audit_action', [
	'settings.updated',
	'settings.reset',
	'agent.config.updated',
	'agent.created',
	'agent.deleted',
	'agent.status.changed',
	'budget_limit.created',
	'budget_limit.updated',
	'budget_limit.deleted',
	'skill.deleted',
	'user.created',
	'user.deactivated',
	'user.role.changed',
])

export const auditEvents = pgTable(
	'audit_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Who performed the action. Nullable so we can attribute system-triggered events
		// (e.g. cron-driven cleanups) without a user. Set-null on user delete preserves the
		// row for compliance even if the user account is removed later.
		actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
		action: auditActionEnum('action').notNull(),
		// Free-form target reference — shape depends on the action. e.g. for
		// `agent.config.updated` this is `{ entityType: 'agent', entityId: '<uuid>' }`.
		targetType: text('target_type'),
		targetId: text('target_id'),
		// Snapshot of the relevant fields BEFORE the change (e.g. agent.config.allowedTools).
		// Null when the action creates a new entity.
		beforeState: jsonb('before_state').$type<Record<string, unknown> | null>(),
		// Snapshot AFTER. Null when the action deletes.
		afterState: jsonb('after_state').$type<Record<string, unknown> | null>(),
		// Optional human-readable summary for the dashboard.
		summary: text('summary'),
		// Request metadata — IP and user-agent help with security forensics.
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		actorIdx: index('audit_events_actor_idx').on(table.actorUserId),
		actionIdx: index('audit_events_action_idx').on(table.action),
		targetIdx: index('audit_events_target_idx').on(table.targetType, table.targetId),
		createdIdx: index('audit_events_created_idx').on(table.createdAt),
	}),
)

export type AuditAction = (typeof auditActionEnum.enumValues)[number]
export type AuditEventRow = typeof auditEvents.$inferSelect
