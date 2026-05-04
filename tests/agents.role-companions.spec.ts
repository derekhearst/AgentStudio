import { expect, test } from '@playwright/test'

/**
 * Wave 5 #22 phase 6 — pure helper invariants for role-based companion suggestions.
 *
 * The helper inspects an agent's `role` text (a short label like "Coding agent for refactor
 * tasks" or "Read-only critic") and returns the non-`core` capability groups whose keyword
 * profile matches. Operators decide whether to bind them.
 */

test.describe('agents/role-companions — keyword classifier', () => {
	test('coding-flavored roles surface the sandbox group', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		expect(suggestCompanionGroupsForRole('Coding agent for refactor tasks')).toContain('sandbox')
		expect(suggestCompanionGroupsForRole('Senior engineer')).toContain('sandbox')
		expect(suggestCompanionGroupsForRole('Debugger that fixes flaky tests')).toContain('sandbox')
	})

	test('research-flavored roles surface the research group', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		expect(suggestCompanionGroupsForRole('Read-only critic that scores agent runs')).toContain('research')
		expect(suggestCompanionGroupsForRole('Researcher and analyst')).toContain('research')
	})

	test('writer/editor roles surface the projects group', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		expect(suggestCompanionGroupsForRole('Spec author for engineering proposals')).toContain('projects')
		expect(suggestCompanionGroupsForRole('Editor for the docs directory')).toContain('projects')
	})

	test('orchestrator/planner roles surface the agents group', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		expect(suggestCompanionGroupsForRole('Orchestrator for multi-step plans')).toContain('agents')
		expect(suggestCompanionGroupsForRole('Planner that delegates work')).toContain('agents')
	})

	test('design-flavored roles surface the media group', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		expect(suggestCompanionGroupsForRole('Visual designer that makes mockups')).toContain('media')
	})

	test('fan-out: a role can match multiple groups', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		const groups = suggestCompanionGroupsForRole('Engineering critic that reviews PR diffs')
		expect(groups).toEqual(expect.arrayContaining(['sandbox', 'research']))
	})

	test('empty / whitespace role yields no suggestions', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		expect(suggestCompanionGroupsForRole('')).toEqual([])
		expect(suggestCompanionGroupsForRole('   \n\t')).toEqual([])
	})

	test('whole-word matching avoids substring false positives', async () => {
		const { suggestCompanionGroupsForRole } = await import('../src/lib/agents/role-companions')
		// "engineering" should match (word boundary), but "engineless" should not.
		expect(suggestCompanionGroupsForRole('Engineless prototype')).not.toContain('sandbox')
		expect(suggestCompanionGroupsForRole('Engineering lead')).toContain('sandbox')
	})

	test('explanation surface returns matched keywords', async () => {
		const { suggestCompanionsForRole } = await import('../src/lib/agents/role-companions')
		const out = suggestCompanionsForRole('Engineering critic')
		const sandbox = out.find((s) => s.group === 'sandbox')
		expect(sandbox?.matchedKeywords.length ?? 0).toBeGreaterThan(0)
	})
})
