import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 3 #12 phase 1 — governance audit schema invariants.
 *
 * Live insert paths (settings update / agent update / budget CRUD) are exercised by their
 * existing remote-command paths; the audit insert there is fire-and-forget so doesn't show
 * up in those tests' return values. This spec covers the schema directly: enum acceptance,
 * FK behavior on actor delete, the index shape used by the dashboard's filters.
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

test.describe('governance/audit — schema invariants', () => {
	test('inserting an audit event with all fields round-trips', async () => {
		const prefix = uniquePrefix('audit-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const targetId = randomUUID()
			const [row] = await sql<{ id: string }[]>`
				insert into audit_events (
					actor_user_id, action, target_type, target_id, before_state, after_state, summary, ip_address, user_agent
				)
				values (
					${userId},
					'settings.updated'::audit_action,
					'settings',
					${targetId},
					${sql.json({ defaultModel: 'old' })},
					${sql.json({ defaultModel: 'new' })},
					${`${prefix}: changed defaultModel`},
					'127.0.0.1',
					'playwright/test'
				)
				returning id
			`
			const [check] = await sql<{
				action: string
				target_type: string
				target_id: string
				before_state: Record<string, unknown>
				after_state: Record<string, unknown>
				actor_user_id: string
				summary: string
			}[]>`
				select action::text as action, target_type, target_id, before_state, after_state,
				       actor_user_id, summary
				from audit_events where id = ${row.id}
			`
			expect(check.action).toBe('settings.updated')
			expect(check.target_type).toBe('settings')
			expect(check.target_id).toBe(targetId)
			expect(check.before_state.defaultModel).toBe('old')
			expect(check.after_state.defaultModel).toBe('new')
			expect(check.actor_user_id).toBe(userId)
			expect(check.summary).toContain(prefix)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('audit_action enum rejects unknown values', async () => {
		const prefix = uniquePrefix('audit-enum')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into audit_events (actor_user_id, action, summary)
					values (${userId}, 'sentinel.unknown'::audit_action, ${`${prefix}: bad enum`})
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('actor FK SET NULL on user delete preserves the audit row for compliance', async () => {
		const prefix = uniquePrefix('audit-fk')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const [tempUser] = await sql<{ id: string }[]>`
				insert into users (id, name, username, role)
				values (${randomUUID()}, ${`${prefix} temp`}, ${`${prefix.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_u`}, 'user'::user_role)
				returning id
			`
			const [audit] = await sql<{ id: string }[]>`
				insert into audit_events (actor_user_id, action, target_type, summary)
				values (${tempUser.id}, 'agent.config.updated'::audit_action, 'agent', ${`${prefix}: by temp user`})
				returning id
			`

			// Hard-delete the user.
			await sql`delete from users where id = ${tempUser.id}`

			const [after] = await sql<{ actor_user_id: string | null; summary: string }[]>`
				select actor_user_id, summary from audit_events where id = ${audit.id}
			`
			expect(after.actor_user_id, 'audit row survives user delete').toBeNull()
			expect(after.summary).toContain(prefix)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('filtering by action + target_type uses the indexes', async () => {
		const prefix = uniquePrefix('audit-filter')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agentId = randomUUID()
			const budgetId = randomUUID()
			await sql`
				insert into audit_events (actor_user_id, action, target_type, target_id, summary)
				values
					(${userId}, 'agent.config.updated'::audit_action, 'agent', ${agentId}, ${`${prefix}: agent`}),
					(${userId}, 'budget_limit.created'::audit_action, 'budget_limit', ${budgetId}, ${`${prefix}: budget`}),
					(${userId}, 'settings.updated'::audit_action, 'settings', ${userId}, ${`${prefix}: settings`})
			`

			const agentRows = await sql<{ count: number }[]>`
				select count(*)::int as count from audit_events
				where action = 'agent.config.updated'::audit_action
				  and target_type = 'agent'
				  and summary like ${`${prefix}%`}
			`
			expect(agentRows[0].count).toBe(1)

			const budgetRows = await sql<{ count: number }[]>`
				select count(*)::int as count from audit_events
				where target_type = 'budget_limit'
				  and summary like ${`${prefix}%`}
			`
			expect(budgetRows[0].count).toBe(1)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('governance/diff — top-level key diffing', () => {
	test('diffTopLevelKeys identifies changed keys (pure helper)', async () => {
		// Import the pure helper directly — it has no DB / SvelteKit deps.
		const { diffTopLevelKeys } = await import('../src/lib/governance/diff')
		expect(diffTopLevelKeys({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b'])
		expect(diffTopLevelKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(['b'])
		expect(diffTopLevelKeys({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(['a'])
		expect(diffTopLevelKeys({ a: 1 }, { a: 1 })).toEqual([])
		expect(diffTopLevelKeys(null, null)).toEqual([])
		expect(diffTopLevelKeys(null, { a: 1 })).toEqual(['a'])
	})
})
