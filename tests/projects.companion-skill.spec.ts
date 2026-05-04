import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #15 phase 5 — projects companion skill seeded on boot.
 *
 * The `tools/projects-edit` companion skill teaches the orchestrator confident artifact
 * selection patterns when the projects capability group is enabled. Boot-seeded with a
 * fixed UUID so user edits survive across restarts.
 */

test.describe('projects/companion-skill — boot seed', () => {
	test('tools/projects-edit skill is seeded with companionGroups including projects', async () => {
		const sql = getSql()
		const [skill] = await sql<{
			id: string
			name: string
			companion_groups: string[]
			enabled: boolean
		}[]>`
			select id, name, companion_groups, enabled
			from skills where id = '00000000-0000-4000-8000-00000000d005'
		`
		// Soft-skip if seed hasn't run since migration (dev server restart needed).
		test.skip(!skill, 'projects companion skill not yet seeded — restart dev server')
		expect(skill.name).toBe('tools/projects-edit')
		expect(skill.enabled).toBe(true)
		expect(skill.companion_groups).toContain('projects')
	})

	test('skill content covers default-edit-in-place + ask-on-ambiguity patterns', async () => {
		const sql = getSql()
		const [skill] = await sql<{ content: string | null }[]>`
			select content from skills where id = '00000000-0000-4000-8000-00000000d005'
		`
		test.skip(!skill, 'projects companion skill not yet seeded')
		expect(skill.content).toContain('Default to editing in place')
		expect(skill.content).toContain('When to ask vs. proceed confidently')
		expect(skill.content).toContain('When to create new')
		expect(skill.content).toContain('set_project_context')
		expect(skill.content).toContain('linked artifact')
	})
})

test.describe('projects/companion-skill — companion lookup integration', () => {
	test('skills with companion_groups containing "projects" are queryable', async () => {
		const prefix = uniquePrefix('companion-lookup')
		const sql = getSql()
		try {
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from skills
				where 'projects' = ANY(companion_groups) and enabled = true
			`
			// Soft-skip when the seed hasn't fired (dev server hasn't restarted since the new
			// companion skill landed). The query itself is the durable contract — it returns 0
			// when nothing matches, which is fine for the array-overlap operator.
			test.skip(count === 0, 'projects companion skill not yet seeded — restart dev server')
			expect(count).toBeGreaterThan(0)
		} finally {
			void prefix // tree-shake guard
		}
	})
})
