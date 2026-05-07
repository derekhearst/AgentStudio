import { expect, test } from '@playwright/test'

/**
 * PR-2 SKILL.md package format — pure parse/serialize round-trip.
 *
 * Pins the canonical authoring format: a SKILL.md document with YAML-style frontmatter and a
 * markdown body. The same module is used by the import command (single-skill paste) and by
 * the upcoming repo file boot loader (PR-4) — round-trip stability is load-bearing for both.
 *
 * Pure helpers — no DB. The remote command + DB upsert path is exercised by the existing
 * skills CRUD test (`tests/crud/skills.crud.spec.ts`); this file pins the parse/serialize
 * contract independently.
 */

test.describe('skills/skill-source — parseSkillSource', () => {
	test('extracts required name + description from YAML frontmatter', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		const out = parseSkillSource(
			[
				'---',
				'name: tools/test-skill',
				'description: A skill for the test suite.',
				'---',
				'',
				'# Body',
				'',
				'The instructions live here.',
			].join('\n'),
		)
		expect(out.frontmatter.name).toBe('tools/test-skill')
		expect(out.frontmatter.description).toBe('A skill for the test suite.')
		expect(out.body).toBe('# Body\n\nThe instructions live here.')
	})

	test('parses optional category, tags, companion_groups, companion_tools, enabled', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		const out = parseSkillSource(
			[
				'---',
				'name: tools/sandbox-fs',
				'description: How to safely inspect files.',
				'category: tool',
				'tags: [system, companion, sandbox]',
				'enabled: true',
				'---',
				'Body.',
			].join('\n'),
		)
		expect(out.frontmatter.category).toBe('tool')
		expect(out.frontmatter.tags).toEqual(['system', 'companion', 'sandbox'])
		expect(out.frontmatter.enabled).toBe(true)
	})

	test('throws when frontmatter is missing entirely', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		expect(() => parseSkillSource('# Just a body\n\nno frontmatter.')).toThrow(/frontmatter/i)
	})

	test('throws when name is missing', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		expect(() =>
			parseSkillSource(['---', 'description: only desc', '---', 'body'].join('\n')),
		).toThrow(/name/i)
	})

	test('throws when description is missing', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		expect(() =>
			parseSkillSource(['---', 'name: only-name', '---', 'body'].join('\n')),
		).toThrow(/description/i)
	})

	test('throws when body is empty', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		expect(() =>
			parseSkillSource(
				['---', 'name: x', 'description: y', '---', '', '   ', ''].join('\n'),
			),
		).toThrow(/body/i)
	})

	test('rejects unknown category values', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		expect(() =>
			parseSkillSource(
				['---', 'name: x', 'description: y', 'category: bogus', '---', 'body'].join('\n'),
			),
		).toThrow(/category/i)
	})

	test('description over 500 chars is rejected', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		const long = 'x'.repeat(501)
		expect(() =>
			parseSkillSource(['---', 'name: x', `description: ${long}`, '---', 'body'].join('\n')),
		).toThrow(/500/)
	})
})

test.describe('skills/skill-source — serializeSkillSource', () => {
	test('emits only the frontmatter keys that have values', async () => {
		const { serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const out = serializeSkillSource({
			name: 'tools/min',
			description: 'Minimal skill.',
			content: 'Body.',
		})
		expect(out).toContain('name: tools/min')
		expect(out).toContain('description: Minimal skill.')
		expect(out).not.toContain('tags:')
		expect(out).not.toContain('companion_groups:')
		expect(out).not.toContain('enabled:')
	})

	test('emits enabled: false but skips enabled: true (default)', async () => {
		const { serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const enabled = serializeSkillSource({
			name: 'x',
			description: 'y',
			content: 'b',
			enabled: true,
		})
		const disabled = serializeSkillSource({
			name: 'x',
			description: 'y',
			content: 'b',
			enabled: false,
		})
		expect(enabled).not.toContain('enabled:')
		expect(disabled).toContain('enabled: false')
	})

	test('round-trip: parse(serialize(x)) preserves all fields', async () => {
		const { parseSkillSource, serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const original = {
			name: 'tools/round-trip',
			description: 'A round-trip stability fixture.',
			content: '# Body\n\nFirst paragraph.\n\nSecond paragraph.',
			category: 'tool',
			tags: ['alpha', 'beta'],
			enabled: false,
		}
		const md = serializeSkillSource(original)
		const reparsed = parseSkillSource(md)
		expect(reparsed.frontmatter.name).toBe(original.name)
		expect(reparsed.frontmatter.description).toBe(original.description)
		expect(reparsed.frontmatter.category).toBe(original.category)
		expect(reparsed.frontmatter.tags).toEqual(original.tags)
		expect(reparsed.frontmatter.enabled).toBe(false)
		expect(reparsed.body).toBe(original.content.trim())
	})

	test('round-trip is byte-stable: serialize(parse(serialize(x))) === serialize(x)', async () => {
		const { parseSkillSource, serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const first = serializeSkillSource({
			name: 'tools/stable',
			description: 'Byte-stable serialization fixture.',
			content: 'Body content.',
			tags: ['a', 'b'],
		})
		const reparsed = parseSkillSource(first)
		const second = serializeSkillSource({
			name: reparsed.frontmatter.name,
			description: reparsed.frontmatter.description,
			content: reparsed.body,
			category: reparsed.frontmatter.category,
			tags: reparsed.frontmatter.tags,
			enabled: reparsed.frontmatter.enabled,
		})
		expect(second).toBe(first)
	})
})
