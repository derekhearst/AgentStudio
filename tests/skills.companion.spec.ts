import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const SANDBOX_SKILL_ID = '00000000-0000-4000-8000-00000000d001'
const SKILLS_SKILL_ID = '00000000-0000-4000-8000-00000000d002'
const AGENTS_SKILL_ID = '00000000-0000-4000-8000-00000000d003'
const MEDIA_SKILL_ID = '00000000-0000-4000-8000-00000000d004'

async function ensureBootSeeded() {
	// Touch any route so hooks.server.ts → bootstrapDatabase → seedCompanionSkills runs.
	await fetch('http://127.0.0.1:4173/')
}

test.describe('skills/companion — bootstrap seed', () => {
	test('first-party companion skills exist after boot, one per capability group', async () => {
		await ensureBootSeeded()
		const sql = getSql()
		const rows = await sql<
			{ id: string; name: string; companion_groups: string[]; enabled: boolean }[]
		>`
			select id, name, companion_groups, enabled from skills
			where id in (${SANDBOX_SKILL_ID}, ${SKILLS_SKILL_ID}, ${AGENTS_SKILL_ID}, ${MEDIA_SKILL_ID})
			order by name asc
		`
		const byId = new Map(rows.map((r) => [r.id, r]))
		expect(byId.size, 'all four companion skills should be seeded').toBe(4)
		expect(byId.get(SANDBOX_SKILL_ID)?.companion_groups).toContain('sandbox')
		expect(byId.get(SKILLS_SKILL_ID)?.companion_groups).toContain('skills')
		expect(byId.get(AGENTS_SKILL_ID)?.companion_groups).toContain('agents')
		expect(byId.get(MEDIA_SKILL_ID)?.companion_groups).toContain('media')
		for (const r of rows) expect(r.enabled).toBe(true)
	})
})

test.describe('skills/companion — overlap lookup by group', () => {
	test('the && array overlap query finds companion skills for a single group', async () => {
		await ensureBootSeeded()
		const sql = getSql()
		const rows = await sql<{ id: string; name: string }[]>`
			select id, name from skills
			where enabled = true and companion_groups && ${'{sandbox}'}::text[]
			order by name asc
		`
		expect(rows.find((r) => r.id === SANDBOX_SKILL_ID)).toBeTruthy()
		expect(rows.find((r) => r.id === MEDIA_SKILL_ID)).toBeFalsy()
	})

	test('the && overlap returns the union when multiple groups are passed', async () => {
		await ensureBootSeeded()
		const sql = getSql()
		const rows = await sql<{ id: string }[]>`
			select id from skills
			where enabled = true and companion_groups && ${'{sandbox,media}'}::text[]
		`
		const ids = new Set(rows.map((r) => r.id))
		expect(ids.has(SANDBOX_SKILL_ID)).toBe(true)
		expect(ids.has(MEDIA_SKILL_ID)).toBe(true)
		expect(ids.has(AGENTS_SKILL_ID)).toBe(false)
	})

	test('user-authored skill with companion_groups overlaps the lookup', async () => {
		const prefix = uniquePrefix('companion-user-authored')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const skillName = `${prefix} sandbox tips`
			await sql`
				insert into skills (name, description, content, companion_groups, enabled)
				values (
					${skillName},
					'User-authored sandbox tips for companion lookup',
					'# Sandbox tips\n\nUse search before edit.',
					${'{sandbox}'}::text[],
					true
				)
			`
			const rows = await sql<{ id: string; name: string }[]>`
				select id, name from skills
				where enabled = true and companion_groups && ${'{sandbox}'}::text[]
				order by name asc
			`
			expect(rows.find((r) => r.name === skillName), 'user-authored companion skill should be returned').toBeTruthy()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('skills/companion — column defaults are forward-compat', () => {
	test('a row with no companion arrays defaults to empty arrays (no NULLs)', async () => {
		const prefix = uniquePrefix('companion-defaults')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const skillName = `${prefix} bare skill`
			await sql`
				insert into skills (name, description, content)
				values (${skillName}, 'No companion fields set', '# bare')
			`
			const [row] = await sql<{ companion_groups: string[]; companion_tools: string[] }[]>`
				select companion_groups, companion_tools from skills where name = ${skillName}
			`
			expect(row.companion_groups).toEqual([])
			expect(row.companion_tools).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
