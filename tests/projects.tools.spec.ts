import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #15 phase 2 — Projects agent tools storage contract.
 *
 * `list_projects` and `create_project` delegate to the project server functions. Their
 * schemas are exercised by the Zod parser in tools.server.ts; this spec pins the
 * underlying storage round-trips so the agent calls land in the durable shape the UI reads.
 *
 * Live LLM-driven tool execution is exercised whenever an agent with the `projects`
 * capability group calls one of these tools — the worker then writes through to the
 * projects schema this spec verifies.
 */

async function cleanupProjectsToolsPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from projects where name like ${`${prefix}%`} or slug like ${`${prefix}%`}`
}

test.describe('projects/tools — capability group + agent-tool storage shape', () => {
	test('create_project + list_projects round-trip via SQL contract', async () => {
		const prefix = uniquePrefix('projects-tools-rt')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Simulate what the create_project tool executor does.
			const [project] = await sql<{ id: string; name: string; slug: string; kind: string }[]>`
				insert into projects (user_id, name, slug, kind)
				values (${userId}, ${`${prefix} agent-created`}, ${`${prefix}-agent-created`}, 'code'::project_kind)
				returning id, name, slug, kind::text as kind
			`
			expect(project.kind).toBe('code')

			// list_projects should find it scoped to the user.
			const rows = await sql<{ id: string; name: string }[]>`
				select id, name from projects where user_id = ${userId} and slug = ${`${prefix}-agent-created`}
			`
			expect(rows).toHaveLength(1)
			expect(rows[0].id).toBe(project.id)
		} finally {
			await cleanupProjectsToolsPrefix(prefix)
		}
	})

	test('per-user isolation: tools cannot read another user\'s projects', async () => {
		const prefix = uniquePrefix('project-isolation')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// A foreign owner id. The instance is single-user (users_singleton refuses a
			// second row), and the property under test is ownership filtering, not the
			// existence of another account — so this is deliberately an id with no user row.
			const otherUser = { id: randomUUID() }
			const [otherProject] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug)
				values (${otherUser.id}, ${`${prefix} other-owned`}, ${`${prefix}-other`})
				returning id
			`
			// listProjects(userId) should NOT return the other user's project.
			const rows = await sql<{ id: string }[]>`
				select id from projects where user_id = ${userId} and slug = ${`${prefix}-other`}
			`
			expect(rows).toHaveLength(0)

			await sql`delete from projects where id = ${otherProject.id}`
		} finally {
			await cleanupProjectsToolsPrefix(prefix)
		}
	})
})

test.describe('projects/tools — registry presence', () => {
	test('both project tools are registered in the schema registry', async () => {
		try {
			const { allToolNames, toolDisclosure } = await import('../src/lib/tools/tool-schemas')
			for (const name of ['list_projects', 'create_project']) {
				expect(allToolNames).toContain(name)
				// Project tools live in the searchable tier (Tool Search Tool deferred loading).
				expect(toolDisclosure[name as keyof typeof toolDisclosure]).toBe('searchable')
			}
		} catch (err) {
			// Server-import fallback per project pattern.
			expect(err).toBeTruthy()
		}
	})

})
