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
	type: 'pull_request_ready' | 'pull_request_checks_failed' | 'automation_summary' | 'policy_override_request'
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

		// The filter dropdown is a <select> with options for each type. Wait for it: the
		// inbox renders client-side, so querying straight after `domcontentloaded` finds
		// no options at all and reports every expected label as missing.
		const typeFilter = page.locator('select').first()
		await typeFilter.waitFor({ state: 'visible', timeout: 30_000 })
		const selectOptions = await page.locator('select option').allTextContents()
		const allOptions = selectOptions.join('|')
		expect(allOptions).toContain('Pull request ready')
		expect(allOptions).toContain('Automation summary')
		expect(allOptions).toContain('Policy override request')
	})

	test('filtering by "PR checks failed" shows the CI failures and nothing else', async ({ page }) => {
		// The filter used to fail validation, leaving the previous filter's items on screen
		// under the "PR checks failed" label.
		test.setTimeout(60_000)
		const prefix = uniquePrefix('review-ci-filter')
		await authenticateContext(page.context())

		try {
			await seedReviewItem({
				type: 'pull_request_checks_failed',
				severity: 'warning',
				summary: `${prefix} CI failed on #7 — build`,
				payload: { checkName: 'build', prNumber: 7 },
			})
			await seedReviewItem({
				type: 'automation_summary',
				severity: 'info',
				summary: `${prefix} nightly summary`,
				payload: { kind: 'maintenance_summary' },
			})

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/review', { waitUntil: 'domcontentloaded' })
			await expect(page.locator('body')).toContainText(`${prefix} nightly summary`, { timeout: 30_000 })

			// The inbox's type filter — the logs panel above it has selects of its own.
			const typeFilter = page.locator('select', { has: page.locator('option[value="pull_request_checks_failed"]') })
			await typeFilter.selectOption('pull_request_checks_failed')

			await expect(page.locator('body')).not.toContainText(`${prefix} nightly summary`, { timeout: 15_000 })
			await expect(page.locator('body')).toContainText(`${prefix} CI failed on #7`)
			await expect(page.getByTestId('inbox-error')).toHaveCount(0)
		} finally {
			await clearItems(prefix)
		}
	})

	test('under "Open queue" the type and severity filters still narrow the list', async ({ page }) => {
		// "Open queue" read only the limit, so every type and severity filter listed the whole
		// queue under its own label. The queue sorts by severity first, so the items that must
		// show unfiltered are critical: the newest criticals head it however full it is.
		test.setTimeout(60_000)
		const prefix = uniquePrefix('review-open-queue-filter')
		await authenticateContext(page.context())

		try {
			await seedReviewItem({
				type: 'pull_request_checks_failed',
				severity: 'warning',
				summary: `${prefix} CI failed on #9 — build`,
				payload: { checkName: 'build', prNumber: 9 },
			})
			await seedReviewItem({
				type: 'policy_override_request',
				severity: 'critical',
				summary: `${prefix} override request`,
				payload: { reason: 'spec' },
			})
			await seedReviewItem({
				type: 'pull_request_checks_failed',
				severity: 'critical',
				summary: `${prefix} CI failed on #8 — lint`,
				payload: { checkName: 'lint', prNumber: 8 },
			})

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto('/review', { waitUntil: 'domcontentloaded' })
			await expect(page.locator('body')).toContainText(`${prefix} override request`, { timeout: 30_000 })

			const statusFilter = page.locator('select', { has: page.locator('option[value="in_progress"]') })
			await statusFilter.selectOption({ label: 'Open queue' })
			await expect(page.locator('body')).toContainText(`${prefix} override request`)
			await expect(page.locator('body')).toContainText(`${prefix} CI failed on #8`)

			const typeFilter = page.locator('select', { has: page.locator('option[value="pull_request_checks_failed"]') })
			await typeFilter.selectOption('pull_request_checks_failed')
			await expect(page.locator('body')).not.toContainText(`${prefix} override request`, { timeout: 15_000 })
			await expect(page.locator('body')).toContainText(`${prefix} CI failed on #8`)
			await expect(page.locator('body')).toContainText(`${prefix} CI failed on #9`)

			const severityFilter = page.locator('select', { has: page.locator('option[value="critical"]') })
			await severityFilter.selectOption('critical')
			await expect(page.locator('body')).not.toContainText(`${prefix} CI failed on #9`, { timeout: 15_000 })
			await expect(page.locator('body')).toContainText(`${prefix} CI failed on #8`)
			await expect(page.getByTestId('inbox-error')).toHaveCount(0)
		} finally {
			await clearItems(prefix)
		}
	})
})
