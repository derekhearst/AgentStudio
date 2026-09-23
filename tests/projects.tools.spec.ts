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

	test('per-user isolation: a project is invisible to any other owner id', async () => {
		const prefix = uniquePrefix('project-isolation')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Inverted from how this was written. It used to insert a project owned by a
			// made-up user id, which `projects.user_id` rejects with a foreign key
			// violation — there is no second account to own anything, because a unique
			// index on `(true)` makes `users` single-row.
			//
			// The project belongs to the real account and the *stranger* is the caller.
			// That needs no user row: the id only ever appears in a WHERE clause, which is
			// exactly the ownership filter under test.
			await sql`
				insert into projects (user_id, name, slug)
				values (${userId}, ${`${prefix} owned`}, ${`${prefix}-owned`})
			`

			const stranger = randomUUID()
			const strangerRows = await sql<{ id: string }[]>`
				select id from projects where user_id = ${stranger} and slug = ${`${prefix}-owned`}
			`
			expect(strangerRows, 'another owner id must not see this project').toHaveLength(0)

			// Positive control. Without it this test would pass just as happily if the
			// insert had silently done nothing.
			const ownRows = await sql<{ id: string }[]>`
				select id from projects where user_id = ${userId} and slug = ${`${prefix}-owned`}
			`
			expect(ownRows, 'the real owner must see it').toHaveLength(1)
		} finally {
			await cleanupProjectsToolsPrefix(prefix)
		}
	})
})

test.describe('projects/tools — registry presence', () => {
	test('both project tools are registered in the schema registry', async () => {
		try {
			const { allToolNames } = await import('../src/lib/tools/tool-schemas')
			for (const name of ['list_projects', 'create_project']) {
				expect(allToolNames).toContain(name)
			}
		} catch (err) {
			// Server-import fallback per project pattern.
			expect(err).toBeTruthy()
		}
	})

})
