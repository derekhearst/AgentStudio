import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #18 phase 4 — pure resolver for per-agent research config + agent storage shape.
 *
 * The resolver is a pure module (no $env / db deps) so it's fully unit-testable. The storage
 * round-trip uses raw SQL to assert the agents.config.research shape that updateAgentRecord
 * writes.
 */

test.describe('research/config — pure resolver', () => {
	test('null config returns full defaults', async () => {
		const { resolveResearchConfig, DEFAULT_RESEARCH_CONFIG } = await import(
			'../src/lib/research/research-config'
		)
		expect(resolveResearchConfig(null)).toEqual(DEFAULT_RESEARCH_CONFIG)
		expect(resolveResearchConfig(undefined)).toEqual(DEFAULT_RESEARCH_CONFIG)
		expect(resolveResearchConfig({})).toEqual(DEFAULT_RESEARCH_CONFIG)
	})

	test('config without research key returns defaults', async () => {
		const { resolveResearchConfig, DEFAULT_RESEARCH_CONFIG } = await import(
			'../src/lib/research/research-config'
		)
		expect(resolveResearchConfig({ capabilityGroups: ['core'], hooks: {} })).toEqual(DEFAULT_RESEARCH_CONFIG)
	})

	test('plannerModel + synthesizerModel overrides apply', async () => {
		const { resolveResearchConfig } = await import('../src/lib/research/research-config')
		const out = resolveResearchConfig({
			research: {
				plannerModel: 'anthropic/claude-sonnet-4',
				synthesizerModel: 'anthropic/claude-opus-4',
			},
		})
		expect(out.plannerModel).toBe('anthropic/claude-sonnet-4')
		expect(out.synthesizerModel).toBe('anthropic/claude-opus-4')
	})

	test('maxSubQuestions clamps to [1, 12]', async () => {
		// Hardcap raised 8 → 12 in the Deep Research rebuild for runs that need wider planning.
		const { resolveResearchConfig } = await import('../src/lib/research/research-config')
		expect(resolveResearchConfig({ research: { maxSubQuestions: 100 } }).maxSubQuestions).toBe(12)
		expect(resolveResearchConfig({ research: { maxSubQuestions: 0 } }).maxSubQuestions).toBe(1)
		expect(resolveResearchConfig({ research: { maxSubQuestions: -5 } }).maxSubQuestions).toBe(1)
		expect(resolveResearchConfig({ research: { maxSubQuestions: 7 } }).maxSubQuestions).toBe(7)
	})

	test('urlsPerQuestion clamps to [1, 8]', async () => {
		// Hardcap raised 5 → 8 in the Deep Research rebuild so the parallel fan-out can pull
		// more sources per sub-question without changing the runner.
		const { resolveResearchConfig } = await import('../src/lib/research/research-config')
		expect(resolveResearchConfig({ research: { urlsPerQuestion: 99 } }).urlsPerQuestion).toBe(8)
		expect(resolveResearchConfig({ research: { urlsPerQuestion: 0 } }).urlsPerQuestion).toBe(1)
		expect(resolveResearchConfig({ research: { urlsPerQuestion: 3 } }).urlsPerQuestion).toBe(3)
	})

	test('maxFetchChars clamps to [5000, 100000]', async () => {
		const { resolveResearchConfig } = await import('../src/lib/research/research-config')
		expect(resolveResearchConfig({ research: { maxFetchChars: 100 } }).maxFetchChars).toBe(5_000)
		expect(resolveResearchConfig({ research: { maxFetchChars: 1_000_000 } }).maxFetchChars).toBe(100_000)
		expect(resolveResearchConfig({ research: { maxFetchChars: 50_000 } }).maxFetchChars).toBe(50_000)
	})

	test('non-numeric / non-finite values fall back to defaults', async () => {
		const { resolveResearchConfig, DEFAULT_RESEARCH_CONFIG } = await import(
			'../src/lib/research/research-config'
		)
		const out = resolveResearchConfig({
			research: {
				maxSubQuestions: 'eight' as unknown as number,
				urlsPerQuestion: NaN,
				maxFetchChars: Infinity,
			},
		})
		expect(out.maxSubQuestions).toBe(DEFAULT_RESEARCH_CONFIG.maxSubQuestions)
		expect(out.urlsPerQuestion).toBe(DEFAULT_RESEARCH_CONFIG.urlsPerQuestion)
		expect(out.maxFetchChars).toBe(DEFAULT_RESEARCH_CONFIG.maxFetchChars)
	})

	test('empty-string model overrides fall back to defaults', async () => {
		const { resolveResearchConfig, DEFAULT_RESEARCH_CONFIG } = await import(
			'../src/lib/research/research-config'
		)
		const out = resolveResearchConfig({ research: { plannerModel: '   ', synthesizerModel: '' } })
		expect(out.plannerModel).toBe(DEFAULT_RESEARCH_CONFIG.plannerModel)
		expect(out.synthesizerModel).toBe(DEFAULT_RESEARCH_CONFIG.synthesizerModel)
	})

	test('enabled defaults to true; explicit false overrides', async () => {
		const { resolveResearchConfig } = await import('../src/lib/research/research-config')
		expect(resolveResearchConfig({ research: {} }).enabled).toBe(true)
		expect(resolveResearchConfig({ research: { enabled: false } }).enabled).toBe(false)
		expect(resolveResearchConfig({ research: { enabled: true } }).enabled).toBe(true)
	})
})

test.describe('research/config — storage round-trip via agents.config', () => {
	async function cleanupAgentPrefix(prefix: string) {
		const sql = getSql()
		await sql`delete from agents where name like ${`${prefix}%`} or role like ${`${prefix}%`}`
	}

	test('agents.config.research jsonb round-trips', async () => {
		const prefix = uniquePrefix('research-cfg-rt')
		const sql = getSql()
		try {
			const researchCfg = {
				plannerModel: 'anthropic/claude-sonnet-4',
				maxSubQuestions: 6,
				urlsPerQuestion: 3,
			}
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model, config)
				values (
					${`${prefix} agent`},
					${`${prefix} role`},
					'sp',
					'anthropic/claude-sonnet-4',
					${sql.json({ research: researchCfg })}
				)
				returning id
			`
			const [check] = await sql<{ config: Record<string, unknown> }[]>`
				select config from agents where id = ${agent.id}
			`
			const persisted = (check.config as { research?: Record<string, unknown> }).research
			expect(persisted).toEqual(researchCfg)
		} finally {
			await cleanupAgentPrefix(prefix)
		}
	})

	test('research config merges alongside capabilityGroups + hooks without clobbering', async () => {
		const prefix = uniquePrefix('research-cfg-merge')
		const sql = getSql()
		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (name, role, system_prompt, model, config)
				values (
					${`${prefix} agent`},
					${`${prefix} role`},
					'sp',
					'anthropic/claude-sonnet-4',
					${sql.json({ capabilityGroups: ['core', 'research'] })}
				)
				returning id
			`
			// Patch only research; capabilityGroups must survive.
			await sql`
				update agents
				set config = jsonb_set(config, '{research}', ${sql.json({ maxSubQuestions: 8 })}::jsonb)
				where id = ${agent.id}
			`
			const [check] = await sql<{ config: Record<string, unknown> }[]>`
				select config from agents where id = ${agent.id}
			`
			const cfg = check.config as { capabilityGroups?: string[]; research?: { maxSubQuestions?: number } }
			expect(cfg.capabilityGroups).toEqual(['core', 'research'])
			expect(cfg.research?.maxSubQuestions).toBe(8)
		} finally {
			await cleanupAgentPrefix(prefix)
		}
	})
})
