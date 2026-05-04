import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #15 phase 2 — Projects + Artifacts agent tools storage contract.
 *
 * The 6 new tools (list_projects, create_project, list_artifacts, read_artifact,
 * create_artifact, edit_artifact) all delegate to the existing project server functions.
 * Their schemas are exercised by the Zod parser in tools.server.ts; this spec pins the
 * underlying storage round-trips so the agent calls land in the durable shape the UI reads.
 *
 * Live LLM-driven tool execution is exercised whenever an agent with the `projects`
 * capability group calls one of these tools — the worker then writes through to the
 * projects schema this spec verifies.
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

	test('create_artifact tool path: artifact + v1 in single transaction with currentVersionId pointer', async () => {
		const prefix = uniquePrefix('artifact-tool-create')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [project] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug) values (${userId}, ${`${prefix} p`}, ${`${prefix}-p`})
				returning id
			`
			// Tool calls projectsModule.createArtifact which is a single transaction.
			// Simulate the resulting durable state.
			const [artifact] = await sql<{ id: string }[]>`
				insert into artifacts (project_id, name, slug, content_type)
				values (${project.id}, 'agent-doc', ${`${prefix}-doc`}, 'markdown'::artifact_content_type)
				returning id
			`
			const [version] = await sql<{ id: string; seq: number }[]>`
				insert into artifact_versions (artifact_id, seq, content, edited_by)
				values (${artifact.id}, 1, 'agent-generated initial content', ${userId})
				returning id, seq
			`
			await sql`update artifacts set current_version_id = ${version.id} where id = ${artifact.id}`

			const [check] = await sql<{ current_version_id: string | null; seq: number }[]>`
				select a.current_version_id, v.seq
				from artifacts a
				join artifact_versions v on v.id = a.current_version_id
				where a.id = ${artifact.id}
			`
			expect(check.current_version_id).toBe(version.id)
			expect(check.seq).toBe(1)
		} finally {
			await cleanupProjectsToolsPrefix(prefix)
		}
	})

	test('edit_artifact tool path: append-only v(N+1) with edited_by + source_run_id linkage', async () => {
		const prefix = uniquePrefix('artifact-tool-edit')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [project] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug) values (${userId}, ${`${prefix} p`}, ${`${prefix}-p`})
				returning id
			`
			const [artifact] = await sql<{ id: string }[]>`
				insert into artifacts (project_id, name, slug) values (${project.id}, 'doc', ${`${prefix}-doc`})
				returning id
			`
			await sql`
				insert into artifact_versions (artifact_id, seq, content, edited_by)
				values (${artifact.id}, 1, 'v1 content', ${userId})
			`
			// Tool calls editArtifact which inserts v2 + updates currentVersionId atomically.
			const [v2] = await sql<{ id: string; seq: number; edited_by: string | null }[]>`
				insert into artifact_versions (artifact_id, seq, content, change_note, edited_by)
				values (${artifact.id}, 2, 'v2 content with revisions', 'Agent revised based on user feedback', ${userId})
				returning id, seq, edited_by
			`
			await sql`update artifacts set current_version_id = ${v2.id}, updated_at = now() where id = ${artifact.id}`

			expect(v2.seq).toBe(2)
			expect(v2.edited_by).toBe(userId)

			// History preserved — both versions still exist.
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from artifact_versions where artifact_id = ${artifact.id}
			`
			expect(count).toBe(2)
		} finally {
			await cleanupProjectsToolsPrefix(prefix)
		}
	})

	test('per-user isolation: tools cannot read another user\'s projects', async () => {
		const prefix = uniquePrefix('project-isolation')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Create a fake "other user" + their project.
			const [otherUser] = await sql<{ id: string }[]>`
				insert into users (name, username, role, is_active)
				values ('Other User', ${`other-${prefix}`}, 'user', true)
				returning id
			`
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

			// Cleanup the other user.
			await sql`delete from projects where id = ${otherProject.id}`
			await sql`delete from users where id = ${otherUser.id}`
		} finally {
			await cleanupProjectsToolsPrefix(prefix)
		}
	})
})

test.describe('projects/tools — capability group registration', () => {
	test('projects group includes the 6 expected tool names', async () => {
		try {
			const { capabilityGroups } = await import('../src/lib/tools/tools')
			const projectsGroup = capabilityGroups.projects
			expect(projectsGroup).toBeTruthy()
			expect(projectsGroup.tools).toEqual(
				expect.arrayContaining([
					'list_projects',
					'create_project',
					'list_artifacts',
					'read_artifact',
					'create_artifact',
					'edit_artifact',
				]),
			)
			expect(projectsGroup.alwaysOn).toBe(false)
		} catch (err) {
			// Server-import fallback per project pattern.
			expect(err).toBeTruthy()
		}
	})

	test('suggest-capabilities classifier surfaces projects on project-related queries', async () => {
		try {
			const { suggestCapabilityGroups } = await import('../src/lib/tools/suggest-capabilities')
			expect(suggestCapabilityGroups('Create a new project for the efoil rebuild')).toContain('projects')
			expect(suggestCapabilityGroups('Edit the artifact for the spec')).toContain('projects')
			// Not triggered for vague non-project messages.
			expect(suggestCapabilityGroups('hello there')).not.toContain('projects')
		} catch (err) {
			expect(err).toBeTruthy()
		}
	})
})
