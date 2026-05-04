import { db } from '$lib/db.server'
import { auditEvents, type AuditAction, type AuditEventRow } from './governance.schema'
import { diffTopLevelKeys } from './diff'

export { diffTopLevelKeys } from './diff'

/**
 * Wave 3 #12 phase 1 — audit event recorder.
 *
 * Single entry point for the governance audit trail. Best-effort: a thrown DB error never
 * blocks the originating write (the user's settings/agent/budget update should still succeed
 * even if the audit insert fails). Failures are logged for ops visibility.
 *
 * Per-action wrappers below provide ergonomic call sites — the diff/state computation stays
 * close to the place that owns the data.
 */

export type RecordAuditEventInput = {
	actorUserId: string | null
	action: AuditAction
	targetType?: string | null
	targetId?: string | null
	beforeState?: Record<string, unknown> | null
	afterState?: Record<string, unknown> | null
	summary?: string | null
	ipAddress?: string | null
	userAgent?: string | null
}

export async function recordAuditEvent(input: RecordAuditEventInput): Promise<AuditEventRow | null> {
	try {
		const [row] = await db
			.insert(auditEvents)
			.values({
				actorUserId: input.actorUserId,
				action: input.action,
				targetType: input.targetType ?? null,
				targetId: input.targetId ?? null,
				beforeState: input.beforeState ?? null,
				afterState: input.afterState ?? null,
				summary: input.summary ?? null,
				ipAddress: input.ipAddress ?? null,
				userAgent: input.userAgent ?? null,
			})
			.returning()
		return row ?? null
	} catch (err) {
		console.warn('[governance/audit] insert failed; original write succeeds anyway', {
			action: input.action,
			targetId: input.targetId,
			error: err instanceof Error ? err.message : String(err),
		})
		return null
	}
}

/* ── Per-action wrappers ──────────────────────────────────────────────────── */

export async function auditSettingsUpdated(opts: {
	actorUserId: string
	beforeState: Record<string, unknown> | null
	afterState: Record<string, unknown> | null
	ipAddress?: string | null
	userAgent?: string | null
}) {
	const changed = diffTopLevelKeys(opts.beforeState, opts.afterState)
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'settings.updated',
		targetType: 'settings',
		targetId: opts.actorUserId,
		beforeState: opts.beforeState,
		afterState: opts.afterState,
		summary: changed.length > 0 ? `Updated: ${changed.join(', ')}` : 'No-op',
		ipAddress: opts.ipAddress ?? null,
		userAgent: opts.userAgent ?? null,
	})
}

export async function auditAgentConfigUpdated(opts: {
	actorUserId: string
	agentId: string
	beforeState: Record<string, unknown> | null
	afterState: Record<string, unknown> | null
	ipAddress?: string | null
	userAgent?: string | null
}) {
	const changed = diffTopLevelKeys(opts.beforeState, opts.afterState)
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'agent.config.updated',
		targetType: 'agent',
		targetId: opts.agentId,
		beforeState: opts.beforeState,
		afterState: opts.afterState,
		summary: changed.length > 0 ? `Changed: ${changed.join(', ')}` : 'No-op',
		ipAddress: opts.ipAddress ?? null,
		userAgent: opts.userAgent ?? null,
	})
}

export async function auditBudgetLimitChange(opts: {
	actorUserId: string
	limitId: string
	action: 'budget_limit.created' | 'budget_limit.updated' | 'budget_limit.deleted'
	beforeState?: Record<string, unknown> | null
	afterState?: Record<string, unknown> | null
	summary?: string
}) {
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: opts.action,
		targetType: 'budget_limit',
		targetId: opts.limitId,
		beforeState: opts.beforeState ?? null,
		afterState: opts.afterState ?? null,
		summary: opts.summary ?? null,
	})
}

export async function auditAgentStatusChanged(opts: {
	actorUserId: string | null
	agentId: string
	beforeStatus: string | null
	afterStatus: string
}) {
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'agent.status.changed',
		targetType: 'agent',
		targetId: opts.agentId,
		beforeState: { status: opts.beforeStatus },
		afterState: { status: opts.afterStatus },
		summary: `Status: ${opts.beforeStatus ?? '?'} → ${opts.afterStatus}`,
	})
}

export async function auditSkillDeleted(opts: {
	actorUserId: string
	skillId: string
	beforeState: Record<string, unknown> | null
	summary?: string
}) {
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'skill.deleted',
		targetType: 'skill',
		targetId: opts.skillId,
		beforeState: opts.beforeState,
		afterState: null,
		summary: opts.summary ?? null,
	})
}

export async function auditUserCreated(opts: {
	actorUserId: string
	createdUserId: string
	username: string
	role: string
}) {
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'user.created',
		targetType: 'user',
		targetId: opts.createdUserId,
		beforeState: null,
		afterState: { username: opts.username, role: opts.role },
		summary: `Created ${opts.role} ${opts.username}`,
	})
}

export async function auditUserDeactivated(opts: {
	actorUserId: string
	targetUserId: string
	username: string | null
}) {
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'user.deactivated',
		targetType: 'user',
		targetId: opts.targetUserId,
		beforeState: { isActive: true },
		afterState: { isActive: false },
		summary: `Deactivated ${opts.username ?? opts.targetUserId}`,
	})
}

export async function auditUserRoleChanged(opts: {
	actorUserId: string
	targetUserId: string
	username: string | null
	beforeRole: string
	afterRole: string
}) {
	return recordAuditEvent({
		actorUserId: opts.actorUserId,
		action: 'user.role.changed',
		targetType: 'user',
		targetId: opts.targetUserId,
		beforeState: { role: opts.beforeRole },
		afterState: { role: opts.afterRole },
		summary: `${opts.username ?? opts.targetUserId}: ${opts.beforeRole} → ${opts.afterRole}`,
	})
}
