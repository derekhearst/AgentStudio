import { expect, test } from '@playwright/test'
import { authenticateContext, getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #18 phase 4 (revised) — Deep Research is now triggered through the Research agent's
 * `propose_research_plan` tool surface, not via a separate magnifying-glass button on the
 * composer. These tests assert the new contract:
 *
 *   - The home page composer does NOT surface a "Start Deep Research" button (the agent
 *     drives the flow via the AgentSelector + chat stream now).
 *   - The /research index page still renders (legacy / direct-creation entry point).
 *   - The research row schema still matches what `startResearchCommand` and the new
 *     `propose_research_plan` tool handler write.
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
		// through the Research agent's propose_research_plan tool. The AgentSelector drop-down
		// is the way users opt into the research workflow.
		const researchBtn = page.getByRole('button', { name: /Start Deep Research/i })
		await expect(researchBtn).toHaveCount(0)
	})

	test('home page composer surfaces the AgentSelector (research agent is opt-in via the picker)', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/')
		// The agent picker is what the user clicks to switch to the Research agent. Once
		// switched, the chat-stream flow handles propose_research_plan automatically.
		const agentPicker = page.getByRole('button', { name: /agent/i }).first()
		await expect(agentPicker).toBeVisible()
	})

	test('research page renders the legacy direct-creation entry point', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/research')
		await expect(page.getByRole('heading', { name: /^Research$/ })).toBeVisible()
		await expect(page.getByText(/Multi-step Deep Research runs/i)).toBeVisible()
	})

	test('research row schema accepts a pre-seeded plan (the propose_research_plan handler path)', async () => {
		// The new tool handler creates a research row with `plan` already populated from the
		// user-approved sub-questions, so the orchestrator skips its Phase-1 planner LLM call.
		// This asserts the schema accepts that shape so a regression in the column types or
		// jsonb default gets caught immediately, even without the live agent flow.
		const prefix = uniquePrefix('agent-driven-shape')
		const sql = getSql()
		try {
			const [user] = await sql<{ id: string }[]>`
				select id from users where is_active = true and deleted_at is null limit 1
			`
			if (!user) test.fail()

			const seededPlan = JSON.stringify([
				'What is the current consensus on X?',
				'What evidence supports the consensus?',
				'What are the main disagreements?',
				'What recent developments could shift the consensus?',
			])
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
					${seededPlan}::jsonb
				)
				returning id, query, status::text as status, conversation_id, plan
			`
			expect(r.query).toContain('agent-driven')
			expect(r.status).toBe('planning')
			expect(Array.isArray(r.plan)).toBe(true)
			expect(r.plan.length).toBe(4)
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})
})
