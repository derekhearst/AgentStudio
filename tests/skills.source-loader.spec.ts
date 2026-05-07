import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

/**
 * PR-4 — SKILL.md scanner.
 *
 * Pure helper invariants: file walking, frontmatter parsing through `parseSkillSource`,
 * resource discovery. The DB application path lives in `skill-source-loader.server.ts`
 * which transitively imports `$lib/db.server` and can't be loaded from the Playwright Node
 * runtime — same constraint the agent source-loader hits. The scan contract below is what
 * the upsert layer consumes; verifying it is the meaningful unit test boundary.
 */

function makeFixtureRoot(layout: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'agentstudio-skill-source-loader-'))
	for (const [relPath, content] of Object.entries(layout)) {
		const absPath = join(root, relPath)
		mkdirSync(join(absPath, '..'), { recursive: true })
		writeFileSync(absPath, content, 'utf-8')
	}
	return root
}

test.describe('skills/skill-source-loader — pure scanner', () => {
	test('returns empty result when root has no skills/ directory', async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({ 'README.md': '# unrelated' })
		try {
			const out = scanSkillSources(root)
			expect(out.skills).toEqual([])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('picks up a flat skills/<slug>/SKILL.md', async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({
			'skills/my-skill/SKILL.md': [
				'---',
				'name: tools/my-skill',
				'description: A test skill.',
				'---',
				'# My Skill',
				'',
				'Body content.',
			].join('\n'),
		})
		try {
			const out = scanSkillSources(root)
			expect(out.skills).toHaveLength(1)
			const s = out.skills[0]
			expect(s.parsed.frontmatter.name).toBe('tools/my-skill')
			expect(s.parsed.frontmatter.description).toBe('A test skill.')
			expect(s.parsed.body).toBe('# My Skill\n\nBody content.')
			expect(s.resources).toEqual([])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('walks nested namespace directories (tools/sandbox-fs/SKILL.md)', async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({
			'skills/tools/sandbox-fs/SKILL.md': [
				'---',
				'name: tools/sandbox-fs',
				'description: How to safely inspect files.',
				'category: tool',
				'companion_groups: [sandbox]',
				'---',
				'Body.',
			].join('\n'),
			'skills/system/mode-chat/SKILL.md': [
				'---',
				'name: system/mode-chat',
				'description: Chat mode posture.',
				'category: identity',
				'---',
				'Mode body.',
			].join('\n'),
		})
		try {
			const out = scanSkillSources(root)
			expect(out.skills).toHaveLength(2)
			const sandbox = out.skills.find((s) => s.parsed.frontmatter.name === 'tools/sandbox-fs')
			expect(sandbox?.parsed.frontmatter.category).toBe('tool')
			expect(sandbox?.parsed.frontmatter.companionGroups).toEqual(['sandbox'])
			const mode = out.skills.find((s) => s.parsed.frontmatter.name === 'system/mode-chat')
			expect(mode?.parsed.frontmatter.category).toBe('identity')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('attaches resource files from skills/<slug>/resources/*.md', async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({
			'skills/my-skill/SKILL.md': [
				'---',
				'name: tools/my-skill',
				'description: A skill with resources.',
				'---',
				'Body.',
			].join('\n'),
			'skills/my-skill/resources/examples.md': '# Examples\n\nFirst example.',
			'skills/my-skill/resources/pitfalls.md': '# Pitfalls\n\nThings to avoid.',
		})
		try {
			const out = scanSkillSources(root)
			expect(out.skills).toHaveLength(1)
			const r = out.skills[0].resources
			expect(r.map((x) => x.name).sort()).toEqual(['examples.md', 'pitfalls.md'])
			const examples = r.find((x) => x.name === 'examples.md')
			expect(examples?.content).toContain('First example.')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('silently skips a SKILL.md missing required frontmatter', async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({
			// Valid skill — should be picked up.
			'skills/good-skill/SKILL.md': [
				'---',
				'name: tools/good-skill',
				'description: A valid skill.',
				'---',
				'Body.',
			].join('\n'),
			// Missing description — must be dropped silently so a single bad file doesn't
			// break the whole scan.
			'skills/bad-skill/SKILL.md': ['---', 'name: bad', '---', 'body'].join('\n'),
		})
		try {
			const out = scanSkillSources(root)
			expect(out.skills.map((s) => s.parsed.frontmatter.name)).toEqual(['tools/good-skill'])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("doesn't traverse into a `resources/` directory looking for nested SKILL.md", async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({
			'skills/parent/SKILL.md': [
				'---',
				'name: tools/parent',
				'description: Parent skill.',
				'---',
				'Body.',
			].join('\n'),
			// A `resources/` dir might contain markdown that includes a frontmatter block.
			// The walker must not re-interpret these as their own skills.
			'skills/parent/resources/SKILL.md': [
				'---',
				'name: should-be-ignored',
				'description: This file is inside resources/ and must not be scanned as a skill.',
				'---',
				'body',
			].join('\n'),
		})
		try {
			const out = scanSkillSources(root)
			expect(out.skills.map((s) => s.parsed.frontmatter.name)).toEqual(['tools/parent'])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('records the absolute path on each scan entry', async () => {
		const { scanSkillSources } = await import('../src/lib/skills/skill-source-loader')
		const root = makeFixtureRoot({
			'skills/my-skill/SKILL.md': [
				'---',
				'name: tools/my-skill',
				'description: A skill.',
				'---',
				'Body.',
			].join('\n'),
		})
		try {
			const out = scanSkillSources(root)
			expect(out.skills[0].path).toMatch(/skills[\\/]my-skill[\\/]SKILL\.md$/)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
