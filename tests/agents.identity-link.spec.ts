import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #22 phase 2 — agents.identity_skill_id linkage contract.
 */

async function cleanupAgentLinkPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from agents where name like ${`${prefix}%`} or role like ${`${prefix}%`}`
	await sql`delete from skills where name like ${`${prefix}%`}`
}

test.describe('agents/identity-link — agents.identity_skill_id', () => {
	test('identity_skill_id defaults to null', async () => {
		const prefix = uniquePrefix('id-link-default')
		const sql = getSql()
		try {
			const [row] = await sql<{ identity_skill_id: string | null }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} a`}, ${`${prefix} role`}, 'sp', 'anthropic/claude-sonnet-4')
				returning identity_skill_id
			`
			expect(row.identity_skill_id).toBeNull()
		} finally {
			await cleanupAgentLinkPrefix(prefix)
		}
	})

	test('linking + unlinking + relinking round-trips through SQL', async () => {
		const prefix = uniquePrefix('id-link-rt')
		const sql = getSql()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} a`}, ${`${prefix} role`}, 'sp', 'anthropic/claude-sonnet-4')
				returning id
			`
			const [skill] = await sql<{ id: string }[]>`
				insert into skills (name, description, content)
				values (${`${prefix}-identity`}, 'test identity', 'You are a test agent.')
				returning id
			`
			// Link
			await sql`update agents set identity_skill_id = ${skill.id} where id = ${agent.id}`
			const [linked] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(linked.identity_skill_id).toBe(skill.id)
			// Unlink
			await sql`update agents set identity_skill_id = NULL where id = ${agent.id}`
			const [unlinked] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(unlinked.identity_skill_id).toBeNull()
		} finally {
			await cleanupAgentLinkPrefix(prefix)
		}
	})

	test('deleting the skill leaves a stale pointer (audit-chain preserving — no enforced FK)', async () => {
		const prefix = uniquePrefix('id-link-stale')
		const sql = getSql()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} a`}, ${`${prefix} role`}, 'sp', 'anthropic/claude-sonnet-4')
				returning id
			`
			const [skill] = await sql<{ id: string }[]>`
				insert into skills (name, description, content)
				values (${`${prefix}-identity`}, 'd', 'c')
				returning id
			`
			await sql`update agents set identity_skill_id = ${skill.id} where id = ${agent.id}`
			await sql`delete from skills where id = ${skill.id}`
			// Pointer survives — application falls back to systemPrompt at runtime.
			const [check] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(check.identity_skill_id).toBe(skill.id)
		} finally {
			await cleanupAgentLinkPrefix(prefix)
		}
	})
})
