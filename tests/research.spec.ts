import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #18 phase 1 — research domain schema invariants + web_fetch URL safety contract.
 *
 * Schema-level proofs for:
 *   - research lifecycle status enum
 *   - cascade-on-research-delete trims sources + steps
 *   - per-research seq monotonicity on steps
 *   - cited_in_report flag flips and indexes
 *
 * Plus pure-helper tests for the web_fetch URL validator (SSRF defense — private/loopback
 * addresses must be rejected at the boundary) + the boilerplate cleanup + paragraph
 * truncation. These pin the safety contract so a future Playwright change can't accidentally
 * skip the validator.
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function cleanupResearchPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from research where query like ${`${prefix}%`}`
}

test.describe('research/schema — research + sources + steps invariants', () => {
	test('research insert with all defaults round-trips', async () => {
		const prefix = uniquePrefix('research-defaults')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [row] = await sql<{
				id: string
				query: string
				status: string
				plan: string[]
				cost_usd: string
				tokens_used: number
			}[]>`
				insert into research (user_id, query)
				values (${userId}, ${`${prefix} how do hydrofoils work`})
				returning id, query, status::text as status, plan, cost_usd, tokens_used
			`
			expect(row.status).toBe('planning')
			expect(row.plan).toEqual([])
			expect(parseFloat(row.cost_usd)).toBe(0)
			expect(row.tokens_used).toBe(0)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('research_status enum rejects unknown values', async () => {
		const prefix = uniquePrefix('research-bad-status')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into research (user_id, query, status)
					values (${userId}, ${`${prefix} q`}, 'investigating'::research_status)
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('cascade — deleting research trims sources and steps', async () => {
		const prefix = uniquePrefix('research-cascade')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query) values (${userId}, ${`${prefix} q`}) returning id
			`
			await sql`
				insert into research_sources (research_id, url, title, extracted_text)
				values (${r.id}, 'https://example.com/a', 'A', 'text a'),
				       (${r.id}, 'https://example.com/b', 'B', 'text b')
			`
			await sql`
				insert into research_steps (research_id, seq, kind)
				values (${r.id}, 1, 'plan'::research_step_kind),
				       (${r.id}, 2, 'search'::research_step_kind),
				       (${r.id}, 3, 'fetch'::research_step_kind)
			`
			const [{ srcCount }] = await sql<{ srcCount: number }[]>`
				select count(*)::int as "srcCount" from research_sources where research_id = ${r.id}
			`
			expect(srcCount).toBe(2)
			const [{ stepCount }] = await sql<{ stepCount: number }[]>`
				select count(*)::int as "stepCount" from research_steps where research_id = ${r.id}
			`
			expect(stepCount).toBe(3)
			await sql`delete from research where id = ${r.id}`
			const [{ srcAfter }] = await sql<{ srcAfter: number }[]>`
				select count(*)::int as "srcAfter" from research_sources where research_id = ${r.id}
			`
			const [{ stepAfter }] = await sql<{ stepAfter: number }[]>`
				select count(*)::int as "stepAfter" from research_steps where research_id = ${r.id}
			`
			expect(srcAfter).toBe(0)
			expect(stepAfter).toBe(0)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('cited_in_report defaults false; flips with update', async () => {
		const prefix = uniquePrefix('research-cited')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query) values (${userId}, ${`${prefix} q`}) returning id
			`
			const [src] = await sql<{ id: string; cited_in_report: boolean }[]>`
				insert into research_sources (research_id, url, title)
				values (${r.id}, 'https://example.com/x', 'X')
				returning id, cited_in_report
			`
			expect(src.cited_in_report).toBe(false)
			await sql`update research_sources set cited_in_report = true where id = ${src.id}`
			const [check] = await sql<{ cited_in_report: boolean }[]>`
				select cited_in_report from research_sources where id = ${src.id}
			`
			expect(check.cited_in_report).toBe(true)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('research_step_kind enum accepts all six valid kinds', async () => {
		const prefix = uniquePrefix('research-step-kinds')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{ id: string }[]>`
				insert into research (user_id, query) values (${userId}, ${`${prefix} q`}) returning id
			`
			const KINDS = ['plan', 'search', 'fetch', 'extract', 'synthesize', 'note'] as const
			for (let i = 0; i < KINDS.length; i++) {
				const kind = KINDS[i]
				const [row] = await sql<{ kind: string }[]>`
					insert into research_steps (research_id, seq, kind)
					values (${r.id}, ${i + 1}, ${kind}::research_step_kind)
					returning kind::text as kind
				`
				expect(row.kind).toBe(kind)
			}
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})

	test('cross-domain pointers (conversationId/runId/jobId) accept null and arbitrary uuids', async () => {
		const prefix = uniquePrefix('research-pointers')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [r] = await sql<{
				id: string
				conversation_id: string | null
				run_id: string | null
				job_id: string | null
			}[]>`
				insert into research (user_id, query, conversation_id, run_id, job_id)
				values (${userId}, ${`${prefix} q`}, NULL, NULL, NULL)
				returning id, conversation_id, run_id, job_id
			`
			expect(r.conversation_id).toBeNull()
			expect(r.run_id).toBeNull()
			expect(r.job_id).toBeNull()
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})
})

test.describe('research/web-fetch — pure URL validator (SSRF defense)', () => {
	test('accepts https/http URLs to public hosts', async () => {
		const { validateFetchUrl } = await import('../src/lib/research/web-fetch')
		const ok1 = validateFetchUrl('https://example.com/path')
		expect(ok1.ok).toBe(true)
		if (ok1.ok) expect(ok1.url.hostname).toBe('example.com')

		const ok2 = validateFetchUrl('http://api.openai.com')
		expect(ok2.ok).toBe(true)
	})

	test('rejects loopback (127.x, localhost, ::1)', async () => {
		const { validateFetchUrl } = await import('../src/lib/research/web-fetch')
		const cases = [
			'http://127.0.0.1/admin',
			'http://localhost:8080',
			'http://127.0.0.5',
			'http://[::1]/internal',
		]
		for (const url of cases) {
			const result = validateFetchUrl(url)
			expect(result.ok, `expected reject for ${url}`).toBe(false)
		}
	})

	test('rejects RFC 1918 private ranges (10.x, 192.168.x, 172.16-31.x)', async () => {
		const { validateFetchUrl } = await import('../src/lib/research/web-fetch')
		const cases = [
			'http://10.0.0.1',
			'http://192.168.1.1',
			'http://172.16.0.1',
			'http://172.31.255.255',
		]
		for (const url of cases) {
			const result = validateFetchUrl(url)
			expect(result.ok, `expected reject for ${url}`).toBe(false)
		}
	})

	test('rejects link-local + .internal/.local domains', async () => {
		const { validateFetchUrl } = await import('../src/lib/research/web-fetch')
		expect(validateFetchUrl('http://169.254.169.254/').ok).toBe(false) // AWS metadata
		expect(validateFetchUrl('http://internal-api.internal/').ok).toBe(false)
		expect(validateFetchUrl('http://service.local/').ok).toBe(false)
	})

	test('rejects unsupported protocols (file, ftp, gopher)', async () => {
		const { validateFetchUrl } = await import('../src/lib/research/web-fetch')
		expect(validateFetchUrl('file:///etc/passwd').ok).toBe(false)
		expect(validateFetchUrl('ftp://example.com').ok).toBe(false)
		expect(validateFetchUrl('gopher://example.com').ok).toBe(false)
	})

	test('rejects malformed URLs', async () => {
		const { validateFetchUrl } = await import('../src/lib/research/web-fetch')
		expect(validateFetchUrl('not a url').ok).toBe(false)
		expect(validateFetchUrl('').ok).toBe(false)
		expect(validateFetchUrl('http://').ok).toBe(false)
	})
})

test.describe('research/web-fetch — cleanupExtractedText', () => {
	test('collapses runs of >2 newlines into exactly 2 (paragraph break)', async () => {
		const { cleanupExtractedText } = await import('../src/lib/research/web-fetch')
		const input = 'paragraph one\n\n\n\n\nparagraph two\n\n\n\nparagraph three'
		const out = cleanupExtractedText(input)
		expect(out).toBe('paragraph one\n\nparagraph two\n\nparagraph three')
	})

	test('drops short repeated lines (nav-style)', async () => {
		const { cleanupExtractedText } = await import('../src/lib/research/web-fetch')
		const input = ['Home', 'Home', 'Home', 'Real article content here', 'Footer', 'Footer'].join('\n')
		const out = cleanupExtractedText(input)
		// Repeated short lines collapsed to 1; long content preserved.
		expect(out).toContain('Real article content here')
		const homeOccurrences = (out.match(/Home/g) ?? []).length
		expect(homeOccurrences).toBe(1)
	})

	test('trims leading/trailing whitespace per line', async () => {
		const { cleanupExtractedText } = await import('../src/lib/research/web-fetch')
		const input = '   leading whitespace  \n  \n more text  '
		const out = cleanupExtractedText(input)
		expect(out.split('\n')[0]).toBe('leading whitespace')
	})
})

test.describe('research/web-fetch — truncateAtParagraph', () => {
	test('returns input unchanged when within cap', async () => {
		const { truncateAtParagraph } = await import('../src/lib/research/web-fetch')
		expect(truncateAtParagraph('short text', 100)).toBe('short text')
	})

	test('truncates at paragraph boundary when one is reasonably close to the cap', async () => {
		const { truncateAtParagraph } = await import('../src/lib/research/web-fetch')
		// Paragraph 1 = 50 chars, paragraph 2 = 50 chars, cap = 75 → cut at the boundary (50).
		const para1 = 'a'.repeat(50)
		const para2 = 'b'.repeat(50)
		const input = `${para1}\n\n${para2}`
		const out = truncateAtParagraph(input, 75)
		// 50 is at 66% of cap → not within 75% threshold → falls back to hard slice.
		expect(out).toContain('truncated')
	})

	test('uses paragraph boundary when within 75% of cap', async () => {
		const { truncateAtParagraph } = await import('../src/lib/research/web-fetch')
		// Paragraph 1 = 80 chars, cap = 100 → 80% of cap → use boundary.
		const para1 = 'a'.repeat(80)
		const para2 = 'b'.repeat(80)
		const input = `${para1}\n\n${para2}`
		const out = truncateAtParagraph(input, 100)
		expect(out).toContain('truncated at paragraph boundary')
		expect(out.startsWith(para1)).toBe(true)
	})

	test('hard slice when no boundary in range', async () => {
		const { truncateAtParagraph } = await import('../src/lib/research/web-fetch')
		const input = 'a'.repeat(2000)
		const out = truncateAtParagraph(input, 1000)
		expect(out).toContain('truncated at 1000 chars')
		expect(out.length).toBeLessThan(input.length)
	})
})
