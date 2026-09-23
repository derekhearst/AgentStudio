import { expect, test, type Page } from '@playwright/test'
import { authenticateContext, waitForHydration } from './helpers'

/**
 * A page whose data fails to load says so, instead of spinning forever.
 *
 * These pages gated everything on their data being present (`{#if !result}` → spinner)
 * and either had no `catch` or checked the error *after* the spinner branch, so any
 * rejection — a database error, a lost session, a malformed id in the URL — left a
 * spinner that never ended plus an unhandled rejection.
 *
 * The failure is produced by aborting the page's own remote-query request, which is the
 * one thing every one of those causes has in common from the browser's side.
 */

async function failQuery(page: Page, name: string) {
	// Anchored on the function name so `listAgents` does not also catch `listAgentsForPicker`.
	await page.route(new RegExp(`/_app/remote/[^/]+/${name}(\\?|$)`), (route) => route.abort())
}

const PAGES: Array<{ path: string; query: string }> = [
	{ path: '/audit', query: 'listAuditEventsQuery' },
	{ path: '/settings/jobs', query: 'listJobsQuery' },
	{ path: '/settings/hooks', query: 'listHookInvocationsQuery' },
	{ path: '/activity', query: 'listActivity' },
	{ path: '/agents', query: 'listAgents' },
	{ path: '/review', query: 'listReviewItemsQuery' },
]

test.describe('pages show a failed load', () => {
	for (const { path, query } of PAGES) {
		test(`${path} shows an error when ${query} fails`, async ({ page }) => {
			await authenticateContext(page.context())
			await failQuery(page, query)

			await page.goto(path)
			await waitForHydration(page)
			await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible()
		})
	}

	test('/review renders the sections that loaded when one query fails', async ({ page }) => {
		await authenticateContext(page.context())
		await failQuery(page, 'getBudgetStatus')

		await page.goto('/review')
		await waitForHydration(page)
		// One failing query used to hold the whole dashboard on a spinner.
		await expect(page.getByRole('alert').filter({ hasText: 'budget' })).toBeVisible()
		await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible()
	})

	test('/review/trace with a malformed run id says so', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/review/trace/not-a-uuid')
		// The error branch sat after the spinner branch, and a failed load never sets the
		// result — so this spun forever.
		await expect(page.getByRole('alert').filter({ hasText: 'No run with this id.' })).toBeVisible()
	})

	test('/agents/[id] with a malformed id reads as not found', async ({ page }) => {
		await authenticateContext(page.context())
		await page.goto('/agents/not-a-uuid')
		await expect(page.getByText('Agent not found.')).toBeVisible()
	})
})
