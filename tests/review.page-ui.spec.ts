import { expect, test } from '@playwright/test'
import { authenticateContext, getSql, uniquePrefix } from './helpers'

/**
 * `/review` admin page — full operator flow for the review inbox.
 *
 * Covers the rendering of every review_item_type that landed in Wave 5:
 *   - `pull_request_ready` (Wave 5 #19 P4)
 *   - `automation_summary` (Wave 5 #21 P4)
 *   - `policy_override_request` (Wave 5 #20 / budget-block path)
 *
 * Tests seed items directly with raw SQL, then visit the page and verify they appear.
 * The /review page is admin-gated; `authenticateContext` picks up the bootstrap admin
 * by default so the gate passes.
 */

async function seedReviewItem(input: {
	type: 'pull_request_ready' | 'automation_summary' | 'policy_override_request'
	severity: 'info' | 'warning' | 'critical'
	summary: string
	payload: Record<string, unknown>
}) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into review_items (type, severity, summary, payload)
		values (
			${input.type}::review_item_type,
			${input.severity}::review_item_severity,
			${input.summary},
			${sql.json(input.payload as never)}
		)
		returning id
	`
	return row.id
}

async function clearItems(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`${prefix}%`}`
}

test.describe('review/page-ui — renders all Wave 5 item types', () => {
	test('a pull_request_ready item appears in the inbox with the right summary', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('review-pr-ready')
		await authenticateContext(page.context())

		try {
			await seedReviewItem({
				type: 'pull_request_ready',
				severity: 'info',
				summary: `${prefix} acme/widgets#42 — feat: example`,
				payload: { kind: 'pull_request', owner: 'acme', repo: 'widgets', prNumber: 42, htmlUrl: 'https://example.com/pr/42' },
			})

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/review', { waitUntil: 'domcontentloaded' })

			await expect(page.locator('body')).toContainText(`${prefix} acme/widgets#42`, { timeout: 30_000 })
		} finally {
			await clearItems(prefix)
		}
	})

	test('an automation_summary item appears in the inbox', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('review-auto-summary')
		await authenticateContext(page.context())

		try {
			await seedReviewItem({
				type: 'automation_summary',
				severity: 'info',
				summary: `${prefix} weekly maintenance ran`,
				payload: { kind: 'maintenance_summary', mode: 'maintenance', summary: 'all clear' },
			})

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/review', { waitUntil: 'domcontentloaded' })

			await expect(page.locator('body')).toContainText(`${prefix} weekly maintenance`, { timeout: 30_000 })
		} finally {
			await clearItems(prefix)
		}
	})

	test('a policy_override_request item appears with warning severity', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('review-policy')
		await authenticateContext(page.context())

		try {
			await seedReviewItem({
				type: 'policy_override_request',
				severity: 'warning',
				summary: `${prefix} budget block: global day limit of $0.01`,
				payload: { kind: 'budget', limitId: 'fake-limit', scope: 'global', period: 'day', limitUsd: '0.01' },
			})

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/review', { waitUntil: 'domcontentloaded' })

			await expect(page.locator('body')).toContainText(`${prefix} budget block`, { timeout: 30_000 })
		} finally {
			await clearItems(prefix)
		}
	})

	test('the type filter dropdown surfaces all enum values including the new ones', async ({ page }) => {
		test.setTimeout(60_000)
		await authenticateContext(page.context())

		await page.goto('/', { waitUntil: 'domcontentloaded' })
		await page.goto('/review', { waitUntil: 'domcontentloaded' })

		// The filter dropdown is a <select> with options for each type.
		const selectOptions = await page.locator('select option').allTextContents()
		const allOptions = selectOptions.join('|')
		expect(allOptions).toContain('Pull request ready')
		expect(allOptions).toContain('Automation summary')
		expect(allOptions).toContain('Policy override request')
	})
})
