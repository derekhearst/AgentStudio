import { expect, test } from '@playwright/test'
import { authenticateContext, getSql, uniquePrefix } from './helpers'

/**
 * Deep Research is triggered by the Research agent writing a plan to a markdown file
 * (Write + request_plan_approval), not via a separate composer
 * button. These tests assert:
 *
 *   - The home page composer does NOT surface a "Start Deep Research" button.
 *   - The /research index page still renders (legacy / direct-creation entry point).
 *   - The research row schema still accepts a pre-seeded plan (what a runner agent writes
 *     after a request_plan_approval handoff).
 */

async function cleanupResearchPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type = 'research_run' and payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
	await sql`delete from research where query like ${`${prefix}%`}`
}

test.describe('research/composer — agent-driven trigger', () => {
	test('home page composer does NOT render a separate "Start Deep Research" button', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/')
		// Negative assertion — the magnifying-glass button was removed; research now flows
		// through the Research agent's plan-file + request_plan_approval handoff. The
		// AgentSelector drop-down is the way users opt into the research workflow.
		const researchBtn = page.getByRole('button', { name: /Start Deep Research/i })
		await expect(researchBtn).toHaveCount(0)
	})

	test('home page composer surfaces the AgentSelector (research agent is opt-in via the picker)', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/')
		// The agent picker is what the user clicks to switch to the Research agent. Once
		// switched, the chat flow handles plan drafting + handoff automatically.
		const agentPicker = page.getByRole('button', { name: /agent/i }).first()
		await expect(agentPicker).toBeVisible()
	})

	test('research page renders the legacy direct-creation entry point', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/research')
		await expect(page.getByRole('heading', { name: /^Research$/ })).toBeVisible()
		// The "Multi-step Deep Research runs" blurb this used to look for is gone. The page's
		// own description now lives in PageHeader's subtitle, which renders only in the
		// mobile header, so assert on the feed filters instead — they are the page's actual
		// entry point and they render at every width.
		for (const label of ['All', 'Research', 'Images']) {
			await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
		}
	})

	test('research row schema accepts a pre-seeded plan (post-handoff runner path)', async () => {
		// After a request_plan_approval handoff the runner agent can create a research row
		// with `plan` already populated from the approved plan file's sub-questions, so the
		// orchestrator skips its Phase-1 planner LLM call. This asserts the schema accepts that
		// shape so a regression in the column types or jsonb default gets caught immediately.
		const prefix = uniquePrefix('agent-driven-shape')
		const sql = getSql()
		try {
			const [user] = await sql<{ id: string }[]>`
				select id from users order by created_at asc limit 1
			`
			if (!user) test.fail()

			// `sql.json(...)`, not `JSON.stringify(...)::jsonb`. postgres.js sends a JS string
			// as a text parameter, so the cast stored a JSON *scalar* — the column held
			// `"[\"...\"]"` rather than an array, and `Array.isArray` was right to say no.
			// The schema was never the problem; the insert was.
			const seededPlan = [
				'What is the current consensus on X?',
				'What evidence supports the consensus?',
				'What are the main disagreements?',
				'What recent developments could shift the consensus?',
			]
			const [r] = await sql<{
				id: string
				query: string
				status: string
				conversation_id: string | null
				plan: string[]
			}[]>`
				insert into research (user_id, query, status, conversation_id, plan)
				values (
					${user.id},
					${`${prefix} agent-driven query`},
					'planning'::research_status,
					NULL,
					${sql.json(seededPlan)}
				)
				returning id, query, status::text as status, conversation_id, plan
			`
			expect(r.query).toContain('agent-driven')
			expect(r.status).toBe('planning')
			expect(Array.isArray(r.plan)).toBe(true)
			expect(r.plan.length).toBe(4)
			const [stored] = await sql<{ t: string; n: number }[]>`
				select jsonb_typeof(plan) as t, jsonb_array_length(plan) as n from research where id = ${r.id}
			`
			expect(stored.t, 'the column must hold a jsonb array, not a stringified one').toBe('array')
			expect(stored.n).toBe(4)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})
})
