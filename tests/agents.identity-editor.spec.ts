import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #22 phase 3 — schema invariants behind the identity editor flow.
 *
 * Validates the round-trip the route relies on: ensure → seeded skill linked to agent;
 * save → skill content updated + agent pointer unchanged; unlink → pointer cleared but skill
 * survives. Pure SQL coverage (no remote-call invocation) keeps the test independent of
 * SvelteKit's $app/server runtime.
 */

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from agents where name like ${`${prefix}%`} or role like ${`${prefix}%`}`
	await sql`delete from skills where name like ${`${prefix}%`} or name like ${`agent/${prefix}%`}`
}

test.describe('agents/identity-editor — schema invariants', () => {
	test('ensure flow: agent without skill → skill created + linked', async () => {
		const prefix = uniquePrefix('id-ed-ensure')
		await cleanup(prefix)
		const sql = getSql()
		try {
			const [agent] = await sql<{ id: string; identity_skill_id: string | null; system_prompt: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} a`}, 'tester role', 'You are a tester.', 'anthropic/claude-sonnet-4')
				returning id, identity_skill_id, system_prompt
			`
			expect(agent.identity_skill_id).toBeNull()

			// Simulate ensureAgentIdentitySkill: insert skill, link agent.
			const skillName = `agent/${prefix}-${agent.id.slice(0, 8)}/identity`
			const [skill] = await sql<{ id: string; content: string }[]>`
				insert into skills (name, description, content, tags, enabled)
				values (${skillName}, 'Identity prompt', ${agent.system_prompt}, ${sql.array(['agent-identity'])}, true)
				returning id, content
			`
			await sql`update agents set identity_skill_id = ${skill.id} where id = ${agent.id}`

			const [linked] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(linked.identity_skill_id).toBe(skill.id)
			expect(skill.content).toBe('You are a tester.')
		} finally {
			await cleanup(prefix)
		}
	})

	test('save flow: write to skill content, agent pointer unchanged', async () => {
		const prefix = uniquePrefix('id-ed-save')
		await cleanup(prefix)
		const sql = getSql()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} a`}, 'tester', 'old', 'anthropic/claude-sonnet-4')
				returning id
			`
			const [skill] = await sql<{ id: string }[]>`
				insert into skills (name, description, content, enabled)
				values (${`${prefix}-identity`}, 'd', 'old content', true)
				returning id
			`
			await sql`update agents set identity_skill_id = ${skill.id} where id = ${agent.id}`
			// Save = update skill content + bump updatedAt.
			await sql`update skills set content = 'new content', updated_at = now() where id = ${skill.id}`

			const [updated] = await sql<{ content: string }[]>`select content from skills where id = ${skill.id}`
			expect(updated.content).toBe('new content')
			const [check] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(check.identity_skill_id).toBe(skill.id) // pointer unchanged
		} finally {
			await cleanup(prefix)
		}
	})

	test('unlink flow: pointer null, skill row preserved', async () => {
		const prefix = uniquePrefix('id-ed-unlink')
		await cleanup(prefix)
		const sql = getSql()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model)
				values (${`${prefix} a`}, 'tester', 'sp', 'anthropic/claude-sonnet-4')
				returning id
			`
			const [skill] = await sql<{ id: string }[]>`
				insert into skills (name, description, content, enabled)
				values (${`${prefix}-identity`}, 'd', 'c', true)
				returning id
			`
			await sql`update agents set identity_skill_id = ${skill.id} where id = ${agent.id}`
			await sql`update agents set identity_skill_id = NULL where id = ${agent.id}`

			const [unlinked] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(unlinked.identity_skill_id).toBeNull()
			// Skill itself survives (operator can re-link or clean up via /skills).
			const [survives] = await sql<{ id: string }[]>`select id from skills where id = ${skill.id}`
			expect(survives.id).toBe(skill.id)
		} finally {
			await cleanup(prefix)
		}
	})
})
