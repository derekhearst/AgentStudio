import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

	/*
	 * #145 — the serializer escaped an embedded `"` as `\"`, and the parser only stripped
	 * the outer quotes, so every export and re-import added a backslash in front of each one.
	 */
	test('quotes, backslashes and line breaks survive repeated export and import unchanged', async () => {
		const { parseSkillSource, serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const descriptions = [
			'Handles "quoted" input.',
			'A Windows path: C:\\Users\\agent',
			'Ends with a backslash \\',
			'First line.\nSecond line.',
			"It's got 'single' quotes: too",
		]
		for (const original of descriptions) {
			let description = original
			for (let cycle = 0; cycle < 3; cycle++) {
				const md = serializeSkillSource({ name: 'tools/quotes', description, content: 'Body.', tags: ['a, b', 'say "hi"'] })
				const parsed = parseSkillSource(md)
				expect(parsed.frontmatter.description, `${JSON.stringify(original)}, cycle ${cycle}`).toBe(original)
				expect(parsed.frontmatter.tags).toEqual(['a, b', 'say "hi"'])
				description = parsed.frontmatter.description
			}
		}
	})

	test('a single-quoted value reads the way YAML reads it', async () => {
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		const parsed = parseSkillSource(['---', 'name: x', "description: 'It''s here'", '---', 'body'].join('\n'))
		expect(parsed.frontmatter.description).toBe("It's here")
	})
})

test.describe('skills/skill-source — the package (SKILL.md plus resource files)', () => {
	const resources = [
		{ name: 'checklist.md', description: 'Release "steps"', content: '# Checklist\n\n---\n\n## resources/not-a-new-file\n\n- ship it' },
		{ name: 'data.json', content: '{"a": 1}\n' },
	]

	test('resource files come back as files, not as part of the body', async () => {
		const { parseSkillPackage, serializeSkillPackage, serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const skillMd = serializeSkillSource({ name: 'tools/pkg', description: 'Packaged.', content: '# Body\n\nInstructions.' })
		const pkg = parseSkillPackage(serializeSkillPackage(skillMd, resources))

		expect(pkg.resources).toEqual(resources)
		// The old layout (`---` then `## resources/<name>`) was read back as body text.
		const { parseSkillSource } = await import('../src/lib/skills/skill-source')
		expect(parseSkillSource(pkg.source).body).toBe('# Body\n\nInstructions.')
	})

	test('a plain SKILL.md is its own package, with no resources', async () => {
		const { parseSkillPackage } = await import('../src/lib/skills/skill-source')
		const text = ['---', 'name: x', 'description: y', '---', '', 'body <!-- a comment -->'].join('\n')
		expect(parseSkillPackage(text)).toEqual({ source: text, resources: [] })
	})

	test('a section that is never closed, or stray text between sections, is refused rather than dropped', async () => {
		const { parseSkillPackage } = await import('../src/lib/skills/skill-source')
		const head = ['---', 'name: x', 'description: y', '---', 'body', '']
		expect(() => parseSkillPackage([...head, '<!-- skill-resource {"name":"a.md"} -->', 'text'].join('\n'))).toThrow(/a\.md/)
		expect(() =>
			parseSkillPackage(
				[...head, '<!-- skill-resource {"name":"a.md"} -->', 'text', '<!-- /skill-resource -->', 'orphan line'].join('\n'),
			),
		).toThrow(/orphan line/)
		expect(() => parseSkillPackage([...head, '<!-- skill-resource {"nope":1} -->', '<!-- /skill-resource -->'].join('\n'))).toThrow(
			/no name/,
		)
	})
})

test.describe('skills/import-export — a skill survives export and re-import', () => {
	/*
	 * The whole path the export dialog and the /skills Import dialog take, against the
	 * database. Before: the category was not exported and an overwrite import wrote NULL,
	 * dropping an identity skill out of the always-included set; the resource files were
	 * folded into the body; and the description gained a backslash per quote.
	 */
	test('category, description, body and resource files are unchanged after an overwrite import', async () => {
		const { cleanupPrefixedRecords, getSql, seedSkill, uniquePrefix } = await import('./helpers')
		const { exportSkillPackage, importSkillPackage } = await import('../src/lib/skills/skills.server')
		const { serializeSkillPackage } = await import('../src/lib/skills/skill-source')
		const prefix = uniquePrefix('skill-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		try {
			const skill = await seedSkill(prefix, {
				description: `${prefix} handles "quoted" input`,
				content: '# Identity\n\nYou are careful.',
				tags: ['identity', 'e2e'],
				files: [
					{ name: 'voice.md', description: 'Tone "rules"', content: 'Be brief.\n\n---\n\nNo filler.' },
					{ name: 'examples.md', content: '## resources/fake\n\nExample text.' },
				],
			})
			await sql`update skills set category = 'identity' where id = ${skill.id}`
			const read = async () => {
				const [row] = await sql<{ name: string; description: string; content: string; category: string | null; tags: string[] }[]>`
					select name, description, content, category, tags from skills where id = ${skill.id}
				`
				const files = await sql<{ name: string; description: string; content: string }[]>`
					select name, description, content from skill_files where skill_id = ${skill.id} order by sort_order
				`
				return { ...row, files: [...files] }
			}
			const before = await read()

			for (let cycle = 0; cycle < 2; cycle++) {
				const exported = await exportSkillPackage(skill.id)
				expect(exported).not.toBeNull()
				const pasted = serializeSkillPackage(exported!.skillMd, exported!.resources)
				const result = await importSkillPackage({ source: pasted, mode: 'overwrite' })
				expect(result).toMatchObject({ id: skill.id, updated: true })
				expect(await read(), `after cycle ${cycle}`).toEqual(before)
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('skills/import — a refused import says why', () => {
	/*
	 * The /skills Import dialog can only show a refusal's reason when it arrives as a 400,
	 * and only a `UserInputError` becomes one (`withUserInputErrors`). The package checks,
	 * the header checks and the name clash were plain Errors: SvelteKit answered with a 500
	 * whose message is "Internal Error", and the dialog read "Import failed" for all of them.
	 */
	test('a bad package, header or resource file is refused with the reason, as a UserInputError', async () => {
		const { importSkillPackage } = await import('../src/lib/skills/skills.server')
		const { UserInputError } = await import('../src/lib/server/user-input-error')
		const head = ['---', 'name: x', 'description: y', '---', 'body', '']
		const cases: Array<{ source: string; reason: RegExp }> = [
			{ source: '# A body with no header', reason: /frontmatter/ },
			{ source: [...head, '<!-- skill-resource {"name":"a.md"} -->', 'text'].join('\n'), reason: /"a\.md" is missing its closing/ },
			{ source: [...head, '<!-- skill-resource {not json} -->', '<!-- /skill-resource -->'].join('\n'), reason: /Unreadable resource header/ },
			{
				source: [...head, '<!-- skill-resource {"name":"empty.md"} -->', '<!-- /skill-resource -->'].join('\n'),
				reason: /^Resource file "empty\.md": content is empty$/,
			},
		]
		for (const { source, reason } of cases) {
			const err = await importSkillPackage({ source, mode: 'create' }).then(
				() => null,
				(e: unknown) => e,
			)
			expect(err, source).toBeInstanceOf(UserInputError)
			expect((err as Error).message, source).toMatch(reason)
		}
	})

	test('importing a name that exists, without overwrite, is refused with the way out', async () => {
		const { cleanupPrefixedRecords, seedSkill, uniquePrefix } = await import('./helpers')
		const { importSkillPackage } = await import('../src/lib/skills/skills.server')
		const { serializeSkillSource } = await import('../src/lib/skills/skill-source')
		const { UserInputError } = await import('../src/lib/server/user-input-error')
		const prefix = uniquePrefix('skill-import-clash')
		await cleanupPrefixedRecords(prefix)
		try {
			const skill = await seedSkill(prefix)
			const source = serializeSkillSource({ name: skill.name, description: 'Another one.', content: 'Body.' })
			const err = await importSkillPackage({ source, mode: 'create' }).then(
				() => null,
				(e: unknown) => e,
			)
			expect(err).toBeInstanceOf(UserInputError)
			expect((err as Error).message).toMatch(/already exists\. Use overwrite mode/)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the import command answers with the reason and the dialog shows it', async () => {
		const remote = readFileSync(resolve('src/lib/skills/skills.remote.ts'), 'utf8')
		const command = remote.slice(remote.indexOf('export const importSkillCommand'))
		expect(command.slice(0, command.indexOf('\n})'))).toMatch(/withUserInputErrors\(\(\) => importSkillPackage\(/)
		// An HttpError is not an Error, so `e instanceof Error ? e.message : …` showed the fallback.
		const page = readFileSync(resolve('src/routes/skills/+page.svelte'), 'utf8')
		expect(page).toMatch(/importError = remoteErrorMessage\(e, 'Import failed'\)/)
	})
})
