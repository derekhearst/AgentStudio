import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Wave 3 #12 phase 1 — governance audit schema invariants.
 *
 * Live insert paths (settings update / agent update / budget CRUD) are exercised by their
 * existing remote-command paths; the audit insert there is fire-and-forget so doesn't show
 * up in those tests' return values. This spec covers the schema directly: enum acceptance,
 * FK behavior on actor delete, the index shape used by the dashboard's filters.
 */

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

	test('the actor FK is declared ON DELETE SET NULL so audit rows survive a user delete', async () => {
		// This used to insert an audit row against a randomly generated user id and then
		// "delete the user". There was never a user: `actor_user_id` is a real foreign key,
		// so the insert itself failed. Nor can the scenario be staged for real — a unique
		// index on `(true)` makes `users` single-row, and deleting the one account the whole
		// suite shares to watch a cascade is not a trade worth making.
		//
		// The claim worth protecting is the schema rule: if the FK were ever changed to
		// CASCADE, deleting an account would erase its audit trail. Postgres records the
		// rule in the catalog, so assert it there. `confdeltype` is 'n' for SET NULL, 'c'
		// for CASCADE, 'a' for NO ACTION, 'r' for RESTRICT.
		const sql = getSql()
		const [constraint] = await sql<{ confdeltype: string }[]>`
			select confdeltype
			from pg_constraint
			where conname = 'audit_events_actor_user_id_users_id_fk'
		`
		expect(constraint, 'the actor foreign key is missing entirely').toBeDefined()
		expect(constraint.confdeltype, 'deleting a user must null the actor, never delete the audit row').toBe('n')
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
