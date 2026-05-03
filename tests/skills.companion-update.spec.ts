import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

async function insertSkill(prefix: string, options?: { companionGroups?: string[]; companionTools?: string[] }) {
	const sql = getSql()
	const [skill] = await sql<{ id: string }[]>`
		insert into skills (id, name, description, content, companion_groups, companion_tools)
		values (
			${randomUUID()},
			${`${prefix} skill`},
			${'A test skill for companion update.'},
			${'# Skill\n\nBody.'},
			${options?.companionGroups ? sql.array(options.companionGroups) : sql.array([] as string[])},
			${options?.companionTools ? sql.array(options.companionTools) : sql.array([] as string[])}
		)
		returning id
	`
	return skill.id
}

test.describe('skills/companion-update — DB column round-trip', () => {
	test('updating companion_groups via raw SQL persists and is readable as a JS array', async () => {
		const prefix = uniquePrefix('companion-update-groups')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const id = await insertSkill(prefix)
			await sql`
				update skills set companion_groups = ${sql.array(['sandbox', 'skills'])}
				where id = ${id}
			`
			const [row] = await sql<{ companion_groups: string[] }[]>`
				select companion_groups from skills where id = ${id}
			`
			expect(row.companion_groups).toEqual(['sandbox', 'skills'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('updating companion_tools via raw SQL persists with element ordering preserved', async () => {
		const prefix = uniquePrefix('companion-update-tools')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const id = await insertSkill(prefix)
			await sql`
				update skills set companion_tools = ${sql.array(['shell', 'file_patch', 'git_diff'])}
				where id = ${id}
			`
			const [row] = await sql<{ companion_tools: string[] }[]>`
				select companion_tools from skills where id = ${id}
			`
			expect(row.companion_tools).toEqual(['shell', 'file_patch', 'git_diff'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('clearing companion_groups (empty array) round-trips as []', async () => {
		const prefix = uniquePrefix('companion-update-clear')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const id = await insertSkill(prefix, { companionGroups: ['sandbox'] })
			await sql`update skills set companion_groups = ${sql.array([] as string[])} where id = ${id}`
			const [row] = await sql<{ companion_groups: string[] }[]>`
				select companion_groups from skills where id = ${id}
			`
			expect(row.companion_groups).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('updating one companion field leaves the other intact', async () => {
		const prefix = uniquePrefix('companion-update-isolation')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const id = await insertSkill(prefix, {
				companionGroups: ['sandbox'],
				companionTools: ['shell'],
			})
			// Patch only companion_tools.
			await sql`update skills set companion_tools = ${sql.array(['file_patch'])} where id = ${id}`
			const [row] = await sql<{ companion_groups: string[]; companion_tools: string[] }[]>`
				select companion_groups, companion_tools from skills where id = ${id}
			`
			expect(row.companion_groups).toEqual(['sandbox'])
			expect(row.companion_tools).toEqual(['file_patch'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
