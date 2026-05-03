import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

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

async function clearOverrides(userId: string) {
	const sql = getSql()
	await sql`delete from context_slot_configs where user_id = ${userId}`
}

test.describe('context/slot-overrides — context_slot_configs schema', () => {
	test('inserting a user-wide override (agent_id null) round-trips with defaults', async () => {
		const prefix = uniquePrefix('slot-override-userwide')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await clearOverrides(userId)
			await sql`
				insert into context_slot_configs (user_id, slot_name, token_budget, priority, enabled)
				values (${userId}, 'memory', 200, 50, true)
			`
			const [row] = await sql<{
				agent_id: string | null
				slot_name: string
				token_budget: number | null
				priority: number | null
				enabled: boolean
			}[]>`
				select agent_id, slot_name, token_budget, priority, enabled
				from context_slot_configs where user_id = ${userId}
			`
			expect(row.agent_id).toBeNull()
			expect(row.slot_name).toBe('memory')
			expect(row.token_budget).toBe(200)
			expect(row.priority).toBe(50)
			expect(row.enabled).toBe(true)
		} finally {
			await clearOverrides(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('user-wide and per-agent overrides for the same slot coexist', async () => {
		const prefix = uniquePrefix('slot-override-coexist')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		const [agent] = await sql<{ id: string }[]>`
			insert into agents (name, role, system_prompt, model, status)
			values (${`${prefix} agent`}, 'role', '', 'anthropic/claude-sonnet-4', 'idle')
			returning id
		`
		try {
			await clearOverrides(userId)
			// Two different rows for the same slot: one user-wide (agent_id null), one per-agent.
			// Both must succeed because the unique constraint treats NULL agent_id as distinct
			// from any concrete agent_id (standard Postgres NULL semantics).
			await sql`
				insert into context_slot_configs (user_id, agent_id, slot_name, enabled)
				values
					(${userId}, null, 'memory', true),
					(${userId}, ${agent.id}, 'memory', false)
			`

			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from context_slot_configs where user_id = ${userId}
			`
			expect(count).toBe(2)

			// A duplicate per-agent row for the same slot must be rejected by the unique constraint.
			let threw = false
			try {
				await sql`
					insert into context_slot_configs (user_id, agent_id, slot_name, enabled)
					values (${userId}, ${agent.id}, 'memory', true)
				`
			} catch {
				threw = true
			}
			expect(threw, 'second per-agent row for same slot must violate the unique constraint').toBe(true)
		} finally {
			await clearOverrides(userId)
			await sql`delete from agents where id = ${agent.id}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('cascade-deletes overrides when the agent is deleted', async () => {
		const prefix = uniquePrefix('slot-override-cascade')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		const [agent] = await sql<{ id: string }[]>`
			insert into agents (name, role, system_prompt, model, status)
			values (${`${prefix} agent`}, 'role', '', 'anthropic/claude-sonnet-4', 'idle')
			returning id
		`
		try {
			await clearOverrides(userId)
			await sql`
				insert into context_slot_configs (user_id, agent_id, slot_name, enabled)
				values (${userId}, ${agent.id}, 'skills', false)
			`
			await sql`delete from agents where id = ${agent.id}`
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from context_slot_configs where user_id = ${userId}
			`
			expect(count, 'override row must cascade-delete with the agent').toBe(0)
		} finally {
			await clearOverrides(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})
})
