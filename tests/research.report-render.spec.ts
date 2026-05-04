import { expect, test } from '@playwright/test'

/**
 * Wave 4 #18 phase 5 — pure helpers for rendering the synthesized research report with
 * clickable inline `[N]` citations.
 *
 * The /research/[id] page used to render the report as plain `<pre>` text which lost the
 * citation links; these helpers split the report into typed parts so the Svelte template
 * can render `[N]` as anchor tags pointing at the corresponding source URL.
 */

test.describe('research/report-render — splitReportIntoParts', () => {
	test('splits text + citations preserving order', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [
			{ id: 'src-1', url: 'https://a.com/1', title: 'A' },
			{ id: 'src-2', url: 'https://b.com/2', title: 'B' },
		]
		const report = 'According to [1], X is true. Per [2], Y matters more.'
		const parts = splitReportIntoParts(report, sources)
		expect(parts).toHaveLength(5)
		expect(parts[0]).toEqual({ type: 'text', value: 'According to ' })
		expect(parts[1]).toMatchObject({ type: 'citation', n: 1, sourceId: 'src-1', url: 'https://a.com/1' })
		expect(parts[2]).toEqual({ type: 'text', value: ', X is true. Per ' })
		expect(parts[3]).toMatchObject({ type: 'citation', n: 2, sourceId: 'src-2', url: 'https://b.com/2' })
		expect(parts[4]).toEqual({ type: 'text', value: ', Y matters more.' })
	})

	test('out-of-range citations render with sourceId=null + url=null', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'src-1', url: 'https://a.com', title: 'A' }]
		const report = 'Per [1] and also [42] which the model hallucinated.'
		const parts = splitReportIntoParts(report, sources)
		const citations = parts.filter((p) => p.type === 'citation')
		expect(citations).toHaveLength(2)
		expect(citations[0]).toMatchObject({ n: 1, sourceId: 'src-1', url: 'https://a.com' })
		expect(citations[1]).toMatchObject({ n: 42, sourceId: null, url: null })
	})

	test('preserves leading text when report starts with non-citation prose', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'a', url: 'https://a.com', title: 'A' }]
		const parts = splitReportIntoParts('# Summary\n\nLeading prose, then [1].', sources)
		expect(parts[0]).toEqual({ type: 'text', value: '# Summary\n\nLeading prose, then ' })
	})

	test('preserves trailing text after last citation', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'a', url: 'https://a.com', title: 'A' }]
		const parts = splitReportIntoParts('Citing [1] and adding more after.', sources)
		expect(parts[parts.length - 1]).toEqual({ type: 'text', value: ' and adding more after.' })
	})

	test('handles report with no citations as a single text part', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'a', url: 'https://a.com', title: 'A' }]
		const parts = splitReportIntoParts('Just prose, no citations here.', sources)
		expect(parts).toEqual([{ type: 'text', value: 'Just prose, no citations here.' }])
	})

	test('handles empty report', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		expect(splitReportIntoParts('', [])).toEqual([])
		expect(splitReportIntoParts('', [{ id: 'a', url: 'https://a.com' }])).toEqual([])
	})

	test('handles back-to-back citations like [1][2]', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [
			{ id: 'a', url: 'https://a.com', title: 'A' },
			{ id: 'b', url: 'https://b.com', title: 'B' },
		]
		const parts = splitReportIntoParts('See [1][2] together.', sources)
		expect(parts.map((p) => p.type)).toEqual(['text', 'citation', 'citation', 'text'])
	})

	test('reconstructs the original report when text + citation parts are joined', async () => {
		const { splitReportIntoParts } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'a', url: 'https://a.com' }, { id: 'b', url: 'https://b.com' }]
		const report = '## Summary\n\nFirst, [1] says X. Second, [2] confirms Y.\n\n## Sources\n[1] https://a.com\n[2] https://b.com'
		const parts = splitReportIntoParts(report, sources)
		const rebuilt = parts.map((p) => (p.type === 'text' ? p.value : `[${p.n}]`)).join('')
		expect(rebuilt).toBe(report)
	})
})

test.describe('research/report-render — citedSourcesInOrder', () => {
	test('returns sources in first-appearance order, deduped', async () => {
		const { citedSourcesInOrder } = await import('../src/lib/research/report-render')
		const sources = [
			{ id: 'a', url: 'https://a.com' },
			{ id: 'b', url: 'https://b.com' },
			{ id: 'c', url: 'https://c.com' },
		]
		const report = 'Per [3], thing X. Per [1], thing Y. Per [3] again, thing Z.'
		const cited = citedSourcesInOrder(report, sources)
		expect(cited.map((s) => s.id)).toEqual(['c', 'a'])
	})

	test('ignores out-of-range citation indices', async () => {
		const { citedSourcesInOrder } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'a', url: 'https://a.com' }]
		const report = 'Per [1] and per [99] which is bogus.'
		const cited = citedSourcesInOrder(report, sources)
		expect(cited.map((s) => s.id)).toEqual(['a'])
	})

	test('returns empty when no citations exist', async () => {
		const { citedSourcesInOrder } = await import('../src/lib/research/report-render')
		const sources = [{ id: 'a', url: 'https://a.com' }]
		expect(citedSourcesInOrder('Just prose here', sources)).toEqual([])
	})

	test('returns empty when sources list is empty', async () => {
		const { citedSourcesInOrder } = await import('../src/lib/research/report-render')
		expect(citedSourcesInOrder('Per [1] this matters', [])).toEqual([])
	})
})
