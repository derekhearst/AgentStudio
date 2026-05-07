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

	// PR-1 drift fix: `projects` and `research` are real capability groups in tools.ts but the
	// previous hardcoded UI list omitted them. The Zod schema in skills.remote.ts now refines
	// against the in-process registry, so any group present in `capabilityGroups` is valid.
	// The DB column itself has always allowed any text — these tests pin the storage contract.
	test('newer capability groups (projects, research) round-trip through companion_groups', async () => {
		const prefix = uniquePrefix('companion-update-newer-groups')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const id = await insertSkill(prefix, { companionGroups: ['projects', 'research'] })
			const [row] = await sql<{ companion_groups: string[] }[]>`
				select companion_groups from skills where id = ${id}
			`
			expect(row.companion_groups).toEqual(['projects', 'research'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('skills/companion-update — capability-group registry source of truth', () => {
	test('capabilityGroups exposes all expected non-core companion targets', async () => {
		const { capabilityGroups } = await import('../src/lib/tools/tools')
		const groupNames = Object.keys(capabilityGroups).filter((g) => g !== 'core')
		// Pin the names that the UI now derives from the registry — adding a new group in
		// tools.ts automatically becomes a valid companion target with no parallel list to update.
		for (const expected of ['sandbox', 'skills', 'agents', 'media', 'research', 'projects', 'source_control']) {
			expect(groupNames, `registry missing expected group "${expected}"`).toContain(expected)
		}
	})
})
