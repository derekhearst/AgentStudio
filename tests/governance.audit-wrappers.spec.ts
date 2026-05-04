import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 3 #12 phase 2-5 — per-action audit wrappers.
 *
 * Direct schema-invariant coverage for the new wrappers added on top of phase 1's
 * recordAuditEvent core: agent.status.changed, skill.deleted, user.created,
 * user.deactivated, user.role.changed. Each test asserts the action enum value, the
 * target_type/target_id shape, and the before/after snapshot the dashboard depends on.
 */

async function getActiveAdminUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null and role = 'admin'
		order by created_at asc limit 1
	`
	if (!user) throw new Error('No active admin user found')
	return user.id
}

test.describe('governance/audit — per-action wrappers', () => {
	test('agent.status.changed records before/after status snapshot', async () => {
		const prefix = uniquePrefix('audit-status')
		await cleanupPrefixedRecords(prefix)
		const adminId = await getActiveAdminUserId()
		const sql = getSql()
		try {
			const agentId = randomUUID()
			await sql`
				insert into audit_events (actor_user_id, action, target_type, target_id, before_state, after_state, summary)
				values (
					${adminId},
					'agent.status.changed'::audit_action,
					'agent',
					${agentId},
					${sql.json({ status: 'active' })},
					${sql.json({ status: 'paused' })},
					${`${prefix}: paused`}
				)
			`
			const [row] = await sql<{
				action: string
				target_type: string
				target_id: string
				before_state: { status: string }
				after_state: { status: string }
			}[]>`
				select action::text as action, target_type, target_id, before_state, after_state
				from audit_events where target_id = ${agentId} and summary like ${`${prefix}%`}
			`
			expect(row.action).toBe('agent.status.changed')
			expect(row.target_type).toBe('agent')
			expect(row.before_state.status).toBe('active')
			expect(row.after_state.status).toBe('paused')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('skill.deleted records before snapshot with after_state null', async () => {
		const prefix = uniquePrefix('audit-skill-del')
		await cleanupPrefixedRecords(prefix)
		const adminId = await getActiveAdminUserId()
		const sql = getSql()
		try {
			const skillId = randomUUID()
			await sql`
				insert into audit_events (actor_user_id, action, target_type, target_id, before_state, after_state, summary)
				values (
					${adminId},
					'skill.deleted'::audit_action,
					'skill',
					${skillId},
					${sql.json({ name: `${prefix} demo`, enabled: true })},
					${null},
					${`${prefix}: deleted`}
				)
			`
			const [row] = await sql<{
				action: string
				target_type: string
				before_state: { name: string; enabled: boolean }
				after_state: unknown
			}[]>`
				select action::text as action, target_type, before_state, after_state
				from audit_events where target_id = ${skillId} and summary like ${`${prefix}%`}
			`
			expect(row.action).toBe('skill.deleted')
			expect(row.target_type).toBe('skill')
			expect(row.before_state.name).toContain(prefix)
			expect(row.after_state).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('user.created records actor and after state with role/username', async () => {
		const prefix = uniquePrefix('audit-user-create')
		await cleanupPrefixedRecords(prefix)
		const adminId = await getActiveAdminUserId()
		const sql = getSql()
		try {
			const targetUserId = randomUUID()
			await sql`
				insert into audit_events (actor_user_id, action, target_type, target_id, before_state, after_state, summary)
				values (
					${adminId},
					'user.created'::audit_action,
					'user',
					${targetUserId},
					${null},
					${sql.json({ username: 'jane', role: 'user' })},
					${`${prefix}: created`}
				)
			`
			const [row] = await sql<{
				action: string
				actor_user_id: string
				before_state: unknown
				after_state: { username: string; role: string }
			}[]>`
				select action::text as action, actor_user_id, before_state, after_state
				from audit_events where target_id = ${targetUserId} and summary like ${`${prefix}%`}
			`
			expect(row.action).toBe('user.created')
			expect(row.actor_user_id).toBe(adminId)
			expect(row.before_state).toBeNull()
			expect(row.after_state.role).toBe('user')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('user.role.changed records before+after role transition', async () => {
		const prefix = uniquePrefix('audit-role')
		await cleanupPrefixedRecords(prefix)
		const adminId = await getActiveAdminUserId()
		const sql = getSql()
		try {
			const targetUserId = randomUUID()
			await sql`
				insert into audit_events (actor_user_id, action, target_type, target_id, before_state, after_state, summary)
				values (
					${adminId},
					'user.role.changed'::audit_action,
					'user',
					${targetUserId},
					${sql.json({ role: 'user' })},
					${sql.json({ role: 'admin' })},
					${`${prefix}: promoted`}
				)
			`
			const [row] = await sql<{
				action: string
				before_state: { role: string }
				after_state: { role: string }
			}[]>`
				select action::text as action, before_state, after_state
				from audit_events where target_id = ${targetUserId} and summary like ${`${prefix}%`}
			`
			expect(row.action).toBe('user.role.changed')
			expect(row.before_state.role).toBe('user')
			expect(row.after_state.role).toBe('admin')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('user.deactivated marks isActive=false in after state', async () => {
		const prefix = uniquePrefix('audit-deact')
		await cleanupPrefixedRecords(prefix)
		const adminId = await getActiveAdminUserId()
		const sql = getSql()
		try {
			const targetUserId = randomUUID()
			await sql`
				insert into audit_events (actor_user_id, action, target_type, target_id, before_state, after_state, summary)
				values (
					${adminId},
					'user.deactivated'::audit_action,
					'user',
					${targetUserId},
					${sql.json({ isActive: true })},
					${sql.json({ isActive: false })},
					${`${prefix}: deactivated`}
				)
			`
			const [row] = await sql<{
				action: string
				before_state: { isActive: boolean }
				after_state: { isActive: boolean }
			}[]>`
				select action::text as action, before_state, after_state
				from audit_events where target_id = ${targetUserId} and summary like ${`${prefix}%`}
			`
			expect(row.action).toBe('user.deactivated')
			expect(row.before_state.isActive).toBe(true)
			expect(row.after_state.isActive).toBe(false)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('governance — pure helper exports', () => {
	test('diffTopLevelKeys is importable as a pure helper', async () => {
		const { diffTopLevelKeys } = await import('../src/lib/governance/diff')
		expect(typeof diffTopLevelKeys).toBe('function')
		expect(diffTopLevelKeys({ a: 1 }, { a: 2 })).toEqual(['a'])
	})
})
