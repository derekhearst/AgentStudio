import { expect, test } from '@playwright/test'

/**
 * Wave 4 #18 phase 2 — pure helpers for the research orchestrator.
 *
 * The runner itself drives real LLM + tool calls; these unit tests pin the parser /
 * URL-scoring / citation-formatting contracts so a regression in the orchestrator's pure
 * core is caught without booting the worker. Mirrors the pattern from evaluator-parse +
 * web-fetch — the LLM-touching code stays thin and delegates to these helpers.
 */

test.describe('research/loop-helpers — parsePlannerResponse', () => {
	test('parses clean JSON response', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const raw = JSON.stringify({ subQuestions: ['What is X?', 'How does Y work?', 'When was Z built?'] })
		expect(parsePlannerResponse(raw)).toEqual(['What is X?', 'How does Y work?', 'When was Z built?'])
	})

	test('strips ```json fences before parsing', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const raw = '```json\n{"subQuestions":["one valid question","two valid questions"]}\n```'
		expect(parsePlannerResponse(raw)).toEqual(['one valid question', 'two valid questions'])
	})

	test('extracts outermost JSON when prose precedes/follows', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const raw = 'Sure! Here you go: {"subQuestions":["aaaa","bbbb"]}\n\nThanks.'
		expect(parsePlannerResponse(raw)).toEqual(['aaaa', 'bbbb'])
	})

	test('falls back to numbered list when no JSON', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const raw = `1. What is the deal with X?
2. How does Y compare to Z?
- Trailing bullet question that goes here?`
		const out = parsePlannerResponse(raw)
		expect(out).toContain('What is the deal with X?')
		expect(out).toContain('How does Y compare to Z?')
		expect(out).toContain('Trailing bullet question that goes here?')
	})

	test('drops sub-questions outside length bounds (under 4 chars or over 239)', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const raw = JSON.stringify({
			subQuestions: ['no', 'a'.repeat(300), 'this one is exactly fine for a sub-question'],
		})
		const out = parsePlannerResponse(raw)
		expect(out).toEqual(['this one is exactly fine for a sub-question'])
	})

	test('caps at 8 sub-questions even when LLM returns 50', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const raw = JSON.stringify({
			subQuestions: Array.from({ length: 50 }, (_, i) => `What about question number ${i + 1}?`),
		})
		const out = parsePlannerResponse(raw)
		expect(out.length).toBe(8)
	})

	test('returns empty for empty/whitespace input', async () => {
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		expect(parsePlannerResponse('')).toEqual([])
		expect(parsePlannerResponse('   ')).toEqual([])
	})

	test('line-fallback picks up plain prose (intentionally lenient — synthesizer filters later)', async () => {
		// The parser's last-ditch fallback treats each line as a candidate sub-question. This is
		// by design — the synthesizer downstream re-evaluates which sub-questions are actually
		// answered, so a noisy planner response degrades gracefully instead of hard-failing.
		const { parsePlannerResponse } = await import('../src/lib/research/research-loop-helpers')
		const out = parsePlannerResponse('absolutely no questions here just prose')
		expect(out).toEqual(['absolutely no questions here just prose'])
	})
})

test.describe('research/loop-helpers — pickUrlsToFetch', () => {
	test('prefers .gov / .edu / .org over commercial sites', async () => {
		const { pickUrlsToFetch } = await import('../src/lib/research/research-loop-helpers')
		const hits = [
			{ url: 'https://example.com/article', rank: 0 },
			{ url: 'https://nasa.gov/research', rank: 1 },
			{ url: 'https://random.io/blog', rank: 2 },
		]
		const picked = pickUrlsToFetch(hits, 1)
		expect(picked[0].url).toBe('https://nasa.gov/research')
	})

	test('penalizes pinterest/quora/reddit', async () => {
		const { pickUrlsToFetch } = await import('../src/lib/research/research-loop-helpers')
		const hits = [
			{ url: 'https://reddit.com/r/foo', rank: 0 },
			{ url: 'https://example.com/article', rank: 1 },
		]
		const picked = pickUrlsToFetch(hits, 1)
		expect(picked[0].url).toBe('https://example.com/article')
	})

	test('dedupes by hostname', async () => {
		const { pickUrlsToFetch } = await import('../src/lib/research/research-loop-helpers')
		const hits = [
			{ url: 'https://wikipedia.org/wiki/A', rank: 0 },
			{ url: 'https://wikipedia.org/wiki/B', rank: 1 },
			{ url: 'https://other.org/page', rank: 2 },
		]
		const picked = pickUrlsToFetch(hits, 3)
		expect(picked.length).toBe(2) // only one wikipedia + one other.org
		const hosts = picked.map((p) => new URL(p.url).hostname)
		expect(new Set(hosts).size).toBe(2)
	})

	test('respects original rank as tiebreaker when scores match', async () => {
		const { pickUrlsToFetch } = await import('../src/lib/research/research-loop-helpers')
		const hits = [
			{ url: 'https://example1.com/page', rank: 5 },
			{ url: 'https://example2.com/page', rank: 1 },
			{ url: 'https://example3.com/page', rank: 3 },
		]
		const picked = pickUrlsToFetch(hits, 3)
		expect(picked.map((p) => p.url)).toEqual([
			'https://example2.com/page',
			'https://example3.com/page',
			'https://example1.com/page',
		])
	})

	test('respects limit parameter', async () => {
		const { pickUrlsToFetch } = await import('../src/lib/research/research-loop-helpers')
		const hits = Array.from({ length: 10 }, (_, i) => ({ url: `https://site${i}.com/`, rank: i }))
		expect(pickUrlsToFetch(hits, 2).length).toBe(2)
		expect(pickUrlsToFetch(hits, 5).length).toBe(5)
	})
})

test.describe('research/loop-helpers — buildSourcesPromptBlock', () => {
	test('builds numbered block with citation map', async () => {
		const { buildSourcesPromptBlock } = await import('../src/lib/research/research-loop-helpers')
		const sources = [
			{ id: 'src-1', url: 'https://a.com/1', title: 'First', extractedText: 'First content' },
			{ id: 'src-2', url: 'https://b.com/2', title: 'Second', extractedText: 'Second content' },
		]
		const { block, citationMap } = buildSourcesPromptBlock(sources)
		expect(block).toContain('### [1] First')
		expect(block).toContain('### [2] Second')
		expect(block).toContain('First content')
		expect(citationMap.get('[1]')).toBe('src-1')
		expect(citationMap.get('[2]')).toBe('src-2')
	})

	test('handles missing title + truncates per-source text', async () => {
		const { buildSourcesPromptBlock } = await import('../src/lib/research/research-loop-helpers')
		const longText = 'x'.repeat(8000)
		const sources = [{ id: 'src-1', url: 'https://a.com', title: null, extractedText: longText }]
		const { block } = buildSourcesPromptBlock(sources, 4000)
		expect(block).toContain('(untitled)')
		// Block should contain only the first 4000 chars of text, not the full 8000.
		expect(block.includes(longText)).toBe(false)
		expect(block.includes('x'.repeat(4000))).toBe(true)
	})
})

test.describe('research/loop-helpers — extractCitedSourceIds', () => {
	test('finds [N] keys present in the report', async () => {
		const { extractCitedSourceIds } = await import('../src/lib/research/research-loop-helpers')
		const map = new Map([
			['[1]', 'src-1'],
			['[2]', 'src-2'],
			['[3]', 'src-3'],
		])
		const report = 'According to [1], the X is Y. Per [3], it works because Z. (Also see [1].)'
		const cited = extractCitedSourceIds(report, map)
		expect(cited.sort()).toEqual(['src-1', 'src-3'])
	})

	test('ignores out-of-range citation keys', async () => {
		const { extractCitedSourceIds } = await import('../src/lib/research/research-loop-helpers')
		const map = new Map([['[1]', 'src-1']])
		const report = 'Per [1] and also [42] which the model hallucinated.'
		const cited = extractCitedSourceIds(report, map)
		expect(cited).toEqual(['src-1'])
	})

	test('returns empty when report has no citations', async () => {
		const { extractCitedSourceIds } = await import('../src/lib/research/research-loop-helpers')
		const map = new Map([['[1]', 'src-1']])
		expect(extractCitedSourceIds('Just prose with no citations.', map)).toEqual([])
	})

	test('dedupes when same key appears multiple times', async () => {
		const { extractCitedSourceIds } = await import('../src/lib/research/research-loop-helpers')
		const map = new Map([['[1]', 'src-1']])
		const report = '[1] [1] [1] [1] [1]'
		expect(extractCitedSourceIds(report, map)).toEqual(['src-1'])
	})
})
