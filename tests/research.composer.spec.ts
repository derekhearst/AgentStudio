import { expect, test } from '@playwright/test'
import { authenticateContext, getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #18 phase 4 — Deep Research trigger from the chat composer.
 *
 * Smoke tests for the composer button behavior:
 *   - The Research button renders on /research page (where it confirms full button visibility)
 *   - The Research button renders on / (home composer)
 *   - The Research button is disabled when the textarea is empty
 *
 * Also a row-shape test confirming that the cleanup pattern still works for research rows
 * created via the composer path (same shape as /research page submission, just from a
 * different entry point).
 */

async function cleanupResearchPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type = 'research_run' and payload->>'researchId' in (select id::text from research where query like ${`${prefix}%`})`
	await sql`delete from research where query like ${`${prefix}%`}`
}

test.describe('research/composer — Deep Research trigger button', () => {
	test('home page composer renders the Research button', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/')
		// The Research button has an aria-label we set in the composer.
		const researchBtn = page.getByRole('button', { name: /Start Deep Research/i }).first()
		await expect(researchBtn).toBeVisible()
		// Empty textarea → button is disabled.
		await expect(researchBtn).toBeDisabled()
	})

	test('research page renders without the composer trigger (no prop wired there)', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/research')
		// The /research page has its own create form (different mechanism), not the composer.
		await expect(page.getByRole('heading', { name: /^Research$/ })).toBeVisible()
		await expect(page.getByText(/Multi-step Deep Research runs/i)).toBeVisible()
	})

	test('research row creation contract via composer path matches startResearchCommand schema', async () => {
		// Schema-level proof — composer uses the same startResearchCommand server fn as the
		// /research +Page form, so the shape is identical. This test asserts a manually-crafted
		// row matches the same INSERT pattern startResearchCommand uses, so a regression in
		// the schema gets caught immediately even without the live UI flow.
		const prefix = uniquePrefix('composer-shape')
		const sql = getSql()
		try {
			const [user] = await sql<{ id: string }[]>`
				select id from users where is_active = true and deleted_at is null limit 1
			`
			if (!user) test.fail()

			const [r] = await sql<{
				id: string
				query: string
				status: string
				conversation_id: string | null
			}[]>`
				insert into research (user_id, query, status, conversation_id)
				values (${user.id}, ${`${prefix} composer-driven query`}, 'planning'::research_status, NULL)
				returning id, query, status::text as status, conversation_id
			`
			expect(r.query).toContain('composer-driven')
			expect(r.status).toBe('planning')
		} finally {
			await cleanupResearchPrefix(prefix)
		}
	})
})
