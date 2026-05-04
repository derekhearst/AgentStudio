import { expect, test } from '@playwright/test'

/**
 * Wave 5 #22 phase 5 — pure helper invariants for `@import skill-name` expansion.
 *
 * Tests pull the pure module directly (no DB / SvelteKit deps), so they run in
 * the Playwright Node context without a server.
 */

test.describe('agents/fragment-expand — @import expansion', () => {
	test('replaces a standalone @import line with the looked-up content', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const map = new Map<string, string>([['shared/policies', 'Always use camelCase for variables.']])
		const out = await expandFragments('Identity preamble.\n@import shared/policies\nClosing line.', (n) => map.get(n) ?? null)
		expect(out).toBe('Identity preamble.\nAlways use camelCase for variables.\nClosing line.')
	})

	test('mid-line @import is NOT expanded (only standalone-line directives)', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const map = new Map<string, string>([['shared/policies', 'EXPANDED']])
		const out = await expandFragments('See the @import shared/policies marker for details.', (n) => map.get(n) ?? null)
		expect(out).toContain('@import shared/policies')
		expect(out).not.toContain('EXPANDED')
	})

	test('missing fragment leaves a marker, never throws', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const out = await expandFragments('@import nonexistent', () => null)
		expect(out).toBe('<!-- @import:missing nonexistent -->')
	})

	test('cycle is broken by a marker once depth runs out', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const map = new Map<string, string>([
			['a', '@import b'],
			['b', '@import a'],
		])
		const out = await expandFragments('@import a', (n) => map.get(n) ?? null)
		expect(out).toMatch(/@import:cycle/)
	})

	test('depth limit enforced by marker', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const map = new Map<string, string>([
			['a', '@import b'],
			['b', '@import c'],
			['c', '@import d'],
			['d', 'final'],
		])
		// maxDepth=1 → expanding 'a' goes to b, then b->c is blocked (depth exhausted).
		const out = await expandFragments('@import a', (n) => map.get(n) ?? null, { maxDepth: 1 })
		expect(out).toMatch(/@import:depth-exceeded/)
	})

	test('listFragmentImports returns deduped names from imports', async () => {
		const { listFragmentImports } = await import('../src/lib/agents/fragment-expand')
		const text = `Header.\n@import policies/safety\nMiddle.\n@import policies/safety\n@import tools/fs`
		expect(listFragmentImports(text)).toEqual(['policies/safety', 'tools/fs'])
	})

	test('empty content returns empty', async () => {
		const { expandFragments, listFragmentImports } = await import('../src/lib/agents/fragment-expand')
		expect(await expandFragments('', () => null)).toBe('')
		expect(listFragmentImports('')).toEqual([])
	})

	test('content with no imports is unchanged', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const text = 'Plain identity prompt.\nNo imports here.'
		const out = await expandFragments(text, () => null)
		expect(out).toBe(text)
	})

	test('async lookup is awaited correctly', async () => {
		const { expandFragments } = await import('../src/lib/agents/fragment-expand')
		const out = await expandFragments('@import async-fragment', async (n) => {
			await new Promise((r) => setTimeout(r, 5))
			return n === 'async-fragment' ? 'ASYNC_OK' : null
		})
		expect(out).toBe('ASYNC_OK')
	})
})
