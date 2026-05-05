import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { getSql } from './helpers'

/**
 * Wave 5 #22 phase 4 — AGENTS.md scanner.
 *
 * Pure helper invariants: frontmatter parsing, file walk, name resolution. DB invariants:
 * apply with priority=db only inserts new; priority=repo updates existing rows that carry
 * matching `config.sourceSlug`; orchestrator override only fires under priority=repo.
 */

function makeFixtureRoot(layout: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'agentstudio-source-loader-'))
	for (const [relPath, content] of Object.entries(layout)) {
		const absPath = join(root, relPath)
		mkdirSync(join(absPath, '..'), { recursive: true })
		writeFileSync(absPath, content, 'utf-8')
	}
	return root
}

test.describe('agents/agent-source-loader — pure helpers', () => {
	test('extractFrontmatter parses key: value, inline arrays, and dash-lists', async () => {
		const { extractFrontmatter } = await import('../src/lib/agents/agent-source-loader')
		const out = extractFrontmatter(
			[
				'---',
				'name: Codex',
				'role: Coding agent',
				'model: anthropic/claude-sonnet-4',
				'capabilityGroups: [core, sandbox, skills]',
				'---',
				'',
				'You are Codex.',
				'',
				'Be terse.',
			].join('\n'),
		)
		expect(out.frontmatter).toEqual({
			name: 'Codex',
			role: 'Coding agent',
			model: 'anthropic/claude-sonnet-4',
			capabilityGroups: ['core', 'sandbox', 'skills'],
		})
		expect(out.body.startsWith('You are Codex.')).toBe(true)
	})

	test('extractFrontmatter accepts indented dash-lists for arrays', async () => {
		const { extractFrontmatter } = await import('../src/lib/agents/agent-source-loader')
		const out = extractFrontmatter(
			['---', 'name: Codex', 'capabilityGroups:', '  - core', '  - skills', '---', 'body'].join('\n'),
		)
		expect(out.frontmatter?.capabilityGroups).toEqual(['core', 'skills'])
	})

	test('extractFrontmatter strips surrounding quotes from string values', async () => {
		const { extractFrontmatter } = await import('../src/lib/agents/agent-source-loader')
		const out = extractFrontmatter(['---', 'name: "Hello, World"', 'role: \'A role\'', '---', ''].join('\n'))
		expect(out.frontmatter).toEqual({ name: 'Hello, World', role: 'A role' })
	})

	test('extractFrontmatter returns null + full body when no frontmatter present', async () => {
		const { extractFrontmatter } = await import('../src/lib/agents/agent-source-loader')
		const out = extractFrontmatter('Just a plain markdown file.\nNo frontmatter.')
		expect(out.frontmatter).toBeNull()
		expect(out.body).toBe('Just a plain markdown file.\nNo frontmatter.')
	})

	test('resolveAgentName prefers frontmatter name and falls back to title-cased slug', async () => {
		const { resolveAgentName } = await import('../src/lib/agents/agent-source-loader')
		expect(
			resolveAgentName({
				slug: 'code-reviewer',
				path: '/anywhere/AGENT.md',
				frontmatter: { name: 'Critic 9000' },
				systemPrompt: 'x',
			}),
		).toBe('Critic 9000')
		expect(
			resolveAgentName({
				slug: 'code-reviewer',
				path: '/anywhere/AGENT.md',
				frontmatter: {},
				systemPrompt: 'x',
			}),
		).toBe('Code Reviewer')
	})

	test('scanAgentSources returns empty result when root has neither AGENTS.md nor docs/agents/', async () => {
		const { scanAgentSources } = await import('../src/lib/agents/agent-source-loader')
		const root = makeFixtureRoot({ 'README.md': '# unrelated' })
		try {
			const out = scanAgentSources(root)
			expect(out.orchestratorIdentity).toBeNull()
			expect(out.agents).toEqual([])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('scanAgentSources picks up AGENTS.md and per-slug AGENT.md files', async () => {
		const { scanAgentSources } = await import('../src/lib/agents/agent-source-loader')
		const root = makeFixtureRoot({
			'AGENTS.md': 'You are the orchestrator. Custom version.',
			'docs/agents/codex/AGENT.md': [
				'---',
				'name: Codex',
				'role: Coding agent',
				'model: anthropic/claude-haiku-4-5',
				'capabilityGroups: [core, sandbox]',
				'---',
				'',
				'You are Codex. Be careful.',
			].join('\n'),
			'docs/agents/researcher/AGENT.md': [
				'---',
				'role: Research investigator',
				'---',
				'You investigate things.',
			].join('\n'),
			// Should NOT be picked up — wrong filename for an agent definition.
			'docs/agents/plan.md': '# domain plan, not an agent',
		})
		try {
			const out = scanAgentSources(root)
			expect(out.orchestratorIdentity?.content).toContain('Custom version')
			expect(out.agents).toHaveLength(2)
			const codex = out.agents.find((a) => a.slug === 'codex')
			expect(codex?.frontmatter.name).toBe('Codex')
			expect(codex?.frontmatter.capabilityGroups).toEqual(['core', 'sandbox'])
			expect(codex?.systemPrompt).toBe('You are Codex. Be careful.')
			const researcher = out.agents.find((a) => a.slug === 'researcher')
			expect(researcher?.frontmatter.name).toBeUndefined() // resolveAgentName fills from slug
			expect(researcher?.frontmatter.role).toBe('Research investigator')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

test.describe('agents/agent-source-loader — DB application', () => {
	test('priority=db only inserts new agents, never overwrites existing rows', async () => {
		const sql = getSql()
		const fixtureSlug = `slot-test-db-${Date.now()}`
		const newSlug = `new-slot-db-${Date.now()}`

		// Pre-seed an "existing" agent that already carries config.sourceSlug = fixtureSlug.
		await sql`
			insert into agents (name, role, system_prompt, model, config)
			values ('Existing', 'preserved role', 'preserved prompt', 'anthropic/claude-sonnet-4',
				${sql.json({ sourceSlug: fixtureSlug, capabilityGroups: ['core'] })})
		`

		try {
			const { applyAgentSources } = await import('../src/lib/agents/agent-source-loader.server')
			const { db } = await import('../src/lib/db.server')

			const scan = {
				root: '/fake',
				orchestratorIdentity: null,
				agents: [
					{
						slug: fixtureSlug,
						path: '/fake/docs/agents/' + fixtureSlug + '/AGENT.md',
						frontmatter: { name: 'Renamed', role: 'overwritten role' },
						systemPrompt: 'overwritten prompt',
					},
					{
						slug: newSlug,
						path: '/fake/docs/agents/' + newSlug + '/AGENT.md',
						frontmatter: { name: 'BrandNew', role: 'fresh role' },
						systemPrompt: 'fresh prompt',
					},
				],
			}

			const result = await applyAgentSources(db, scan, 'db')
			expect(result.agentsInserted).toBe(1)
			expect(result.agentsUpdated).toBe(0)
			expect(result.agentsSkipped).toBe(1)

			const [existing] = await sql<{ name: string; role: string; system_prompt: string }[]>`
				select name, role, system_prompt
				from agents where config->>'sourceSlug' = ${fixtureSlug}
			`
			expect(existing.name).toBe('Existing')
			expect(existing.role).toBe('preserved role')
			expect(existing.system_prompt).toBe('preserved prompt')

			const [inserted] = await sql<{ name: string; role: string }[]>`
				select name, role
				from agents where config->>'sourceSlug' = ${newSlug}
			`
			expect(inserted.name).toBe('BrandNew')
			expect(inserted.role).toBe('fresh role')
		} finally {
			await sql`delete from agents where config->>'sourceSlug' in (${fixtureSlug}, ${newSlug})`
		}
	})

	test('priority=repo overwrites the row whose config.sourceSlug matches', async () => {
		const sql = getSql()
		const fixtureSlug = `slot-test-repo-${Date.now()}`

		await sql`
			insert into agents (name, role, system_prompt, model, config)
			values ('Existing', 'old role', 'old prompt', 'anthropic/claude-sonnet-4',
				${sql.json({ sourceSlug: fixtureSlug })})
		`

		try {
			const { applyAgentSources } = await import('../src/lib/agents/agent-source-loader.server')
			const { db } = await import('../src/lib/db.server')

			const scan = {
				root: '/fake',
				orchestratorIdentity: null,
				agents: [
					{
						slug: fixtureSlug,
						path: '/fake/docs/agents/' + fixtureSlug + '/AGENT.md',
						frontmatter: {
							name: 'Renamed',
							role: 'new role',
							capabilityGroups: ['core', 'skills'],
						},
						systemPrompt: 'new prompt',
					},
				],
			}

			const result = await applyAgentSources(db, scan, 'repo')
			expect(result.agentsUpdated).toBe(1)
			expect(result.agentsInserted).toBe(0)

			const [updated] = await sql<{ name: string; role: string; system_prompt: string; config: { capabilityGroups?: string[]; sourceSlug?: string } }[]>`
				select name, role, system_prompt, config
				from agents where config->>'sourceSlug' = ${fixtureSlug}
			`
			expect(updated.name).toBe('Renamed')
			expect(updated.role).toBe('new role')
			expect(updated.system_prompt).toBe('new prompt')
			expect(updated.config.capabilityGroups).toEqual(['core', 'skills'])
			expect(updated.config.sourceSlug).toBe(fixtureSlug)
		} finally {
			await sql`delete from agents where config->>'sourceSlug' = ${fixtureSlug}`
		}
	})

	test('agents missing a role frontmatter are skipped with a structured error', async () => {
		const fixtureSlug = `slot-no-role-${Date.now()}`
		const { applyAgentSources } = await import('../src/lib/agents/agent-source-loader.server')
		const { db } = await import('../src/lib/db.server')

		const scan = {
			root: '/fake',
			orchestratorIdentity: null,
			agents: [
				{
					slug: fixtureSlug,
					path: '/fake/docs/agents/' + fixtureSlug + '/AGENT.md',
					frontmatter: { name: 'NoRole' },
					systemPrompt: 'body',
				},
			],
		}

		const result = await applyAgentSources(db, scan, 'repo')
		expect(result.agentsInserted).toBe(0)
		expect(result.agentsSkipped).toBe(1)
		expect(result.errors[0]).toContain('role')

		const sql = getSql()
		const rows = await sql`select id from agents where config->>'sourceSlug' = ${fixtureSlug}`
		expect(rows).toHaveLength(0)
	})
})
