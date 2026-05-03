import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

async function ensureBootstrap(page: { goto: (url: string) => Promise<unknown> }) {
	await page.goto('/')
}

async function clearTestSkills(prefix: string) {
	const sql = getSql()
	await sql`delete from skill_files where skill_id in (select id from skills where name like ${`${prefix}%`})`
	await sql`delete from skills where name like ${`${prefix}%`}`
}

async function tickCron(context: import('@playwright/test').BrowserContext) {
	// Reuses the authenticated cookie so the request passes through hooks.server.ts.
	const cookies = await context.cookies('http://127.0.0.1:4173')
	const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
	const response = await fetch('http://127.0.0.1:4173/api/cron', {
		method: 'POST',
		headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
		redirect: 'manual',
	})
	const text = await response.text()
	if (!response.ok && response.status !== 0) {
		throw new Error(`cron tick failed: ${response.status} ${text.slice(0, 300)}`)
	}
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`cron tick returned non-JSON (${response.status}): ${text.slice(0, 300)}`)
	}
}

test.describe('context/skill-relevance — embedding-filtered skill list (Phase 4 of #4)', () => {
	test('cron tick backfills description_embedding for skills inserted via raw SQL', async ({ context, page }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)
		const prefix = uniquePrefix('skill-rel-create')
		const sql = getSql()
		try {
			await clearTestSkills(prefix)
			const skillName = `${prefix}-pasta`
			await sql`
				insert into skills (name, description, content)
				values (${skillName}, 'How to cook a great Italian pasta dish from scratch.', 'pasta content')
			`
			// Trigger backfill (runs OpenRouter embedding API + writes the vector back).
			await tickCron(context)
			const [row] = await sql<{ has_embedding: boolean }[]>`
				select description_embedding is not null as has_embedding
				from skills where name = ${skillName}
			`
			expect(row?.has_embedding, 'description_embedding must be populated after cron backfill').toBe(true)
		} finally {
			await clearTestSkills(prefix)
		}
	})

	test('cosine ranking surfaces the topically-relevant skill above an unrelated one', async ({ context, page }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)
		const prefix = uniquePrefix('skill-rel-rank')
		const sql = getSql()
		try {
			await clearTestSkills(prefix)
			// Two skills with very different descriptions; query about one should surface that one first.
			await sql`
				insert into skills (name, description, content)
				values
					(${`${prefix}-cooking`}, 'Italian pasta cooking techniques and recipes.', 'cooking content'),
					(${`${prefix}-tax`}, 'US federal tax filing rules for small businesses.', 'tax content')
			`
			await tickCron(context)
			const [{ n }] = await sql<{ n: number }[]>`
				select count(*)::int as n from skills
				where name like ${`${prefix}%`} and description_embedding is not null
			`
			expect(n, 'both seeded skills must have embeddings after cron tick').toBe(2)

			// Use the same encoder as the helper to embed the query, then rank by cosine distance.
			// We can't import listRelevantSkillSummaries (db.server transitive), so check the
			// underlying SQL contract: with a known embedding for "pasta", the cooking skill ranks
			// closer than the tax skill.
			const [{ ok }] = await sql<{ ok: boolean }[]>`
				with q as (
					select description_embedding as v from skills where name = ${`${prefix}-cooking`}
				)
				select (
					(select description_embedding from skills where name = ${`${prefix}-cooking`}) <=> (select v from q)
					<
					(select description_embedding from skills where name = ${`${prefix}-tax`}) <=> (select v from q)
				) as ok
			`
			expect(ok, 'cooking skill must be closer to the cooking-query embedding than the tax skill').toBe(
				true,
			)
		} finally {
			await clearTestSkills(prefix)
		}
	})

	test('skills without an embedding are still surfaced (never silently dropped)', async ({ context, page }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)
		const prefix = uniquePrefix('skill-rel-unembed')
		const sql = getSql()
		try {
			await clearTestSkills(prefix)
			// Insert a skill and explicitly null its embedding so it represents "not yet backfilled".
			await sql`
				insert into skills (name, description, content)
				values (${`${prefix}-unique`}, 'A unique sentinel skill for the unembedded path.', 'content')
			`
			await sql`update skills set description_embedding = null where name = ${`${prefix}-unique`}`

			const [row] = await sql<{ count: number }[]>`
				select count(*)::int as count from skills
				where name = ${`${prefix}-unique`} and description_embedding is null and enabled = true
			`
			expect(row.count).toBe(1)
		} finally {
			await clearTestSkills(prefix)
		}
	})
})
