import { expect, test } from '@playwright/test'

/**
 * Wave 3 #14 evaluations plan phase 5 — sprint contract parser unit tests.
 *
 * Pins the markdown grammar for `## Sprint N: <deliverable>` headers + `Round budget: <N>`
 * lines so authors can rely on a stable shape. The parser is a pure module so these tests
 * exercise the full public surface without needing the runtime.
 *
 * The runner's per-sprint trigger integration (calling `runEvaluatorPass` at sprint
 * boundaries inside the loop) lands in a follow-up — the parser + helpers are the contract,
 * and the loop integration plugs them into the existing eval pipeline.
 */

test.describe('evaluations/sprints — parseSprintContracts', () => {
	test('returns empty when spec has no sprint headers', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		const out = parseSprintContracts('Just a regular task description with no sprints.')
		expect(out).toEqual([])
	})

	test('returns empty for empty / whitespace spec', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		expect(parseSprintContracts('')).toEqual([])
		expect(parseSprintContracts('   \n\n  ')).toEqual([])
	})

	test('parses a single sprint with budget', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		const spec = `## Sprint 1: build the auth flow
Round budget: 5
Implement login + logout + session creation.`
		const out = parseSprintContracts(spec)
		expect(out).toHaveLength(1)
		expect(out[0].index).toBe(1)
		expect(out[0].deliverable).toBe('build the auth flow')
		expect(out[0].roundBudget).toBe(5)
		expect(out[0].cumulativeRoundEnd).toBe(5)
		expect(out[0].description).toContain('Implement login')
		expect(out[0].description).not.toContain('Round budget')
	})

	test('parses multiple sprints with cumulative round thresholds', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		const spec = `# Big task

## Sprint 1: scaffold the schema
Round budget: 3
Add the tables + migrations.

## Sprint 2: write the runner
Round budget: 5
Glue the new module into the orchestrator.

## Sprint 3: ship the UI
Round budget: 4
Render the new state in the chat panel.`
		const out = parseSprintContracts(spec)
		expect(out).toHaveLength(3)
		expect(out.map((s) => s.cumulativeRoundEnd)).toEqual([3, 8, 12])
		expect(out[1].deliverable).toBe('write the runner')
		expect(out[2].description).toContain('chat panel')
	})

	test('handles sprint without explicit round budget — cumulativeRoundEnd stays null', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		const spec = `## Sprint 1: the open-ended one
Just go until the deliverable lands. No budget.`
		const out = parseSprintContracts(spec)
		expect(out).toHaveLength(1)
		expect(out[0].roundBudget).toBeNull()
		expect(out[0].cumulativeRoundEnd).toBeNull()
	})

	test('mixed bounded + unbounded — cumulative skips the unbounded', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		const spec = `## Sprint 1: bounded
Round budget: 4

## Sprint 2: open-ended (drift OK)

## Sprint 3: bounded again
Round budget: 6`
		const out = parseSprintContracts(spec)
		expect(out.map((s) => s.cumulativeRoundEnd)).toEqual([4, null, 10])
	})

	test('accepts dash separator (## Sprint 1 - foo)', async () => {
		const { parseSprintContracts } = await import('../src/lib/evaluations/sprints')
		const spec = `## Sprint 1 - dash separator
Round budget: 2`
		const out = parseSprintContracts(spec)
		expect(out[0].deliverable).toBe('dash separator')
	})
})

test.describe('evaluations/sprints — sprintBoundaryAt', () => {
	test('returns null for round 0 (no rounds completed yet)', async () => {
		const { parseSprintContracts, sprintBoundaryAt } = await import('../src/lib/evaluations/sprints')
		const contracts = parseSprintContracts('## Sprint 1: foo\nRound budget: 3')
		expect(sprintBoundaryAt(contracts, 0)).toBeNull()
	})

	test('returns the sprint when prevRound exactly hits its cumulativeRoundEnd', async () => {
		const { parseSprintContracts, sprintBoundaryAt } = await import('../src/lib/evaluations/sprints')
		const contracts = parseSprintContracts('## Sprint 1: a\nRound budget: 3\n## Sprint 2: b\nRound budget: 5')
		expect(sprintBoundaryAt(contracts, 3)?.deliverable).toBe('a')
		expect(sprintBoundaryAt(contracts, 8)?.deliverable).toBe('b')
		expect(sprintBoundaryAt(contracts, 4)).toBeNull() // mid-sprint
	})

	test('ignores unbounded sprints', async () => {
		const { parseSprintContracts, sprintBoundaryAt } = await import('../src/lib/evaluations/sprints')
		const contracts = parseSprintContracts('## Sprint 1: open\nNo budget here')
		expect(sprintBoundaryAt(contracts, 5)).toBeNull()
	})
})

test.describe('evaluations/sprints — activeSprintForRound', () => {
	test('returns first sprint while round is within its budget', async () => {
		const { parseSprintContracts, activeSprintForRound } = await import('../src/lib/evaluations/sprints')
		const contracts = parseSprintContracts('## Sprint 1: a\nRound budget: 3\n## Sprint 2: b\nRound budget: 5')
		expect(activeSprintForRound(contracts, 1)?.deliverable).toBe('a')
		expect(activeSprintForRound(contracts, 3)?.deliverable).toBe('a')
		expect(activeSprintForRound(contracts, 4)?.deliverable).toBe('b')
		expect(activeSprintForRound(contracts, 8)?.deliverable).toBe('b')
	})

	test('falls back to the LAST sprint when round exceeds all budgets (overflow safety)', async () => {
		const { parseSprintContracts, activeSprintForRound } = await import('../src/lib/evaluations/sprints')
		const contracts = parseSprintContracts('## Sprint 1: a\nRound budget: 3\n## Sprint 2: b\nRound budget: 5')
		expect(activeSprintForRound(contracts, 100)?.deliverable).toBe('b')
	})

	test('returns null when no sprints', async () => {
		const { activeSprintForRound } = await import('../src/lib/evaluations/sprints')
		expect(activeSprintForRound([], 5)).toBeNull()
	})
})
