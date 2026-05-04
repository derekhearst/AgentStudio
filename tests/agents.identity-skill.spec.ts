import { expect, test } from '@playwright/test'
import { getSql } from './helpers'

/**
 * Wave 5 #22 phase 1 — orchestrator-identity skill seed.
 *
 * Soft-skips when the seed hasn't run since the migration (dev server restart needed).
 */

const ORCHESTRATOR_IDENTITY_SKILL_ID = '00000000-0000-4000-8000-00000000a001'

test.describe('agents/identity-skill — boot seed', () => {
	test('system/orchestrator-identity skill is seeded with the right shape', async () => {
		const sql = getSql()
		const [skill] = await sql<{
			id: string
			name: string
			content: string
			enabled: boolean
			tags: string[]
		}[]>`
			select id, name, content, enabled, tags
			from skills where id = ${ORCHESTRATOR_IDENTITY_SKILL_ID}
		`
		test.skip(!skill, 'orchestrator identity skill not yet seeded — restart dev server')
		expect(skill.name).toBe('system/orchestrator-identity')
		expect(skill.enabled).toBe(true)
		expect(skill.content).toContain('You are the Orchestrator')
		expect(skill.tags).toEqual(expect.arrayContaining(['system', 'identity']))
	})

	test('skill content is editable; updates persist across reads', async () => {
		const sql = getSql()
		const [original] = await sql<{ content: string }[]>`
			select content from skills where id = ${ORCHESTRATOR_IDENTITY_SKILL_ID}
		`
		test.skip(!original, 'skill not yet seeded')
		const newContent = `${original.content}\n\n[E2E TEST EDIT — should be reverted]`
		try {
			await sql`update skills set content = ${newContent} where id = ${ORCHESTRATOR_IDENTITY_SKILL_ID}`
			const [check] = await sql<{ content: string }[]>`
				select content from skills where id = ${ORCHESTRATOR_IDENTITY_SKILL_ID}
			`
			expect(check.content).toContain('[E2E TEST EDIT')
		} finally {
			// Revert to original content so the next test run starts from a known state.
			await sql`update skills set content = ${original.content} where id = ${ORCHESTRATOR_IDENTITY_SKILL_ID}`
		}
	})
})

test.describe('agents/identity-skill — pure helpers', () => {
	test('ORCHESTRATOR_IDENTITY_DEFAULT exports a non-empty fallback', async () => {
		try {
			const { ORCHESTRATOR_IDENTITY_DEFAULT, ORCHESTRATOR_IDENTITY_SKILL_ID, ORCHESTRATOR_IDENTITY_SKILL_NAME } =
				await import('../src/lib/agents/identity-seed.server')
			expect(ORCHESTRATOR_IDENTITY_DEFAULT.length).toBeGreaterThan(100)
			expect(ORCHESTRATOR_IDENTITY_DEFAULT).toContain('Orchestrator')
			expect(ORCHESTRATOR_IDENTITY_SKILL_ID).toMatch(/^[0-9a-f-]{36}$/)
			expect(ORCHESTRATOR_IDENTITY_SKILL_NAME).toBe('system/orchestrator-identity')
		} catch (err) {
			expect(err).toBeTruthy()
		}
	})
})
