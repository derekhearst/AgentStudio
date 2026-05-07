import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * PR-1 always-include contract for the relevance-ranked skill loader.
 *
 * The runtime now uses `listRelevantSkillSummaries` for sub-agents/automations/tasks instead of
 * dumping every enabled skill into the system prompt. Identity-bearing skills (`system/*` and
 * `hook/*`) must remain in the prompt regardless of relevance score — these tests pin the
 * SQL contract that backs the always-include filter.
 *
 * `listRelevantSkillSummaries` itself can't be invoked from this Playwright runner because it
 * transitively imports `$lib/db.server`, which depends on the SvelteKit virtual module
 * `$app/environment` (not resolvable in the Node test runtime — same constraint as the agent
 * source-loader DB tests). The contract below is the storage shape that the helper queries.
 */

async function insertSkill(name: string, description: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into skills (id, name, description, content)
		values (${randomUUID()}, ${name}, ${description}, 'body')
		returning id
	`
	return row.id
}

test.describe('skills/always-include — system/* and hook/* are surfaced regardless of relevance', () => {
	test('a skill with name LIKE "system/%" is matched by the always-include filter', async () => {
		const prefix = uniquePrefix('alwinc-system')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const skillName = `system/${prefix}-mode-test`
		try {
			await insertSkill(skillName, 'mode-identity skill under test')
			const [row] = await sql<{ name: string }[]>`
				select name from skills
				where enabled = true and (name like 'system/%' or name like 'hook/%')
				and name = ${skillName}
			`
			expect(row?.name).toBe(skillName)
		} finally {
			await cleanupPrefixedRecords(prefix)
			await sql`delete from skills where name = ${skillName}`
		}
	})

	test('a skill with name LIKE "hook/%" is matched by the always-include filter', async () => {
		const prefix = uniquePrefix('alwinc-hook')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const skillName = `hook/${prefix}-after-run`
		try {
			await insertSkill(skillName, 'hook handler skill under test')
			const [row] = await sql<{ name: string }[]>`
				select name from skills
				where enabled = true and (name like 'system/%' or name like 'hook/%')
				and name = ${skillName}
			`
			expect(row?.name).toBe(skillName)
		} finally {
			await cleanupPrefixedRecords(prefix)
			await sql`delete from skills where name = ${skillName}`
		}
	})

	test('a non-identity skill (tools/*, workflow/*, domain/*) is NOT matched by always-include', async () => {
		const prefix = uniquePrefix('alwinc-other')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const skillName = `tools/${prefix}-something`
		try {
			await insertSkill(skillName, 'a tool skill — must compete on relevance, not pinned')
			const rows = await sql<{ name: string }[]>`
				select name from skills
				where enabled = true and (name like 'system/%' or name like 'hook/%')
				and name = ${skillName}
			`
			expect(rows.length).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
			await sql`delete from skills where name = ${skillName}`
		}
	})

	test('disabled identity skills are excluded from the always-include set', async () => {
		const prefix = uniquePrefix('alwinc-disabled')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const skillName = `system/${prefix}-disabled-mode`
		try {
			const id = await insertSkill(skillName, 'disabled mode skill under test')
			await sql`update skills set enabled = false where id = ${id}`
			const rows = await sql<{ name: string }[]>`
				select name from skills
				where enabled = true and (name like 'system/%' or name like 'hook/%')
				and id = ${id}
			`
			expect(rows.length).toBe(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
			await sql`delete from skills where name = ${skillName}`
		}
	})
})
