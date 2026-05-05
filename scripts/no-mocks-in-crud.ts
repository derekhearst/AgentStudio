#!/usr/bin/env bun
/**
 * Lint guard: tests under `tests/crud/` must not use any mocking primitives.
 *
 * Bans (case-sensitive substring search):
 *   - `MOCK_RESPONSE` / `MOCK_STREAM` (legacy stub markers)
 *   - `vi.mock(`           (vitest mock)
 *   - `jest.mock(`         (jest mock)
 *   - ` mock(`             (generic mock helper, leading space prevents matching `mock-foo`)
 *   - ` stub(`             (generic stub helper)
 *   - `nock(`              (HTTP mock library)
 *   - `MockDate`           (date stubbing)
 *   - `sinon.`             (sinon stubs)
 *
 * Exits non-zero on any hit so CI fails the lint stage. The CRUD layer is the
 * one place we want to guarantee end-to-end real-service coverage.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'tests', 'crud')

const BANNED_PATTERNS: Array<{ name: string; needle: string }> = [
	{ name: 'MOCK_RESPONSE marker', needle: 'MOCK_RESPONSE' },
	{ name: 'MOCK_STREAM marker', needle: 'MOCK_STREAM' },
	{ name: 'vitest vi.mock', needle: 'vi.mock(' },
	{ name: 'jest.mock', needle: 'jest.mock(' },
	{ name: 'generic mock(', needle: ' mock(' },
	{ name: 'generic stub(', needle: ' stub(' },
	{ name: 'nock(', needle: 'nock(' },
	{ name: 'MockDate', needle: 'MockDate' },
	{ name: 'sinon.', needle: 'sinon.' },
]

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const s = statSync(full)
		if (s.isDirectory()) yield* walk(full)
		else if (entry.endsWith('.ts') || entry.endsWith('.svelte')) yield full
	}
}

const offenders: Array<{ file: string; line: number; pattern: string; text: string }> = []
for (const file of walk(ROOT)) {
	const content = readFileSync(file, 'utf8')
	const lines = content.split(/\r?\n/)
	for (const [idx, line] of lines.entries()) {
		for (const p of BANNED_PATTERNS) {
			if (line.includes(p.needle)) {
				offenders.push({ file, line: idx + 1, pattern: p.name, text: line.trim().slice(0, 200) })
			}
		}
	}
}

if (offenders.length === 0) {
	console.log(`✓ No banned mock/stub patterns in ${ROOT}`)
	process.exit(0)
}

console.error(`\n✗ Found ${offenders.length} banned mock/stub pattern(s) under tests/crud/:\n`)
for (const o of offenders) {
	console.error(`  ${o.file}:${o.line}  [${o.pattern}]`)
	console.error(`    ${o.text}`)
}
console.error(`\nThe CRUD layer must use real services end-to-end. Either remove the mock,`)
console.error(`or move the test out of tests/crud/ into a unit-test directory.`)
process.exit(1)
