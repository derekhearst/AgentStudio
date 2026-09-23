import { expect, test, type Page, type Request } from '@playwright/test'
import { authenticateContext, getActiveUserId, getSql, uniquePrefix, waitForHydration } from './helpers'

/**
 * The /memory page's own behaviour — what it asks the server, how often, and what it keeps on
 * screen. Seeded straight into the database; nothing here needs a model.
 */

test.beforeEach(async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'desktop', 'page behaviour, not layout; one project is enough')
	await authenticateContext(page.context())
})

/** The remote function a request calls (`listMemoryClosetsQuery`), or null for anything else. */
function remoteFunctionName(request: Request): string | null {
	const match = /\/_app\/remote\/[^/]+\/([^/?]+)/.exec(new URL(request.url()).pathname)
	return match ? match[1] : null
}

/** Every remote argument a URL carries, decoded — a query sends its argument as `?payload=`. */
function decodedUrlPayload(url: string): string {
	const payload = new URL(url).searchParams.get('payload')
	return payload ? Buffer.from(payload, 'base64url').toString('utf8') : ''
}

/** Count calls to each remote function from now on. */
function countRemoteCalls(page: Page) {
	const counts = new Map<string, number>()
	const requests: Request[] = []
	page.on('request', (request) => {
		requests.push(request)
		const name = remoteFunctionName(request)
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
	})
	return {
		requests,
		count: (name: string) => counts.get(name) ?? 0,
	}
}

async function openManage(page: Page) {
	await page.goto('/memory')
	await waitForHydration(page)
	await page.getByRole('button', { name: 'Manage', exact: true }).click()
	const panel = page.getByRole('dialog', { name: 'Memory management' })
	await expect(panel).toBeVisible()
	await expect(panel.locator('.loading-spinner')).toHaveCount(0)
	return panel
}

test.describe('memory/palace-ui — deny-list tester', () => {
	test('the pasted text travels in a POST body, never in a URL', async ({ page }) => {
		// A query sends its argument in the GET URL, where a reverse proxy's access log keeps
		// it — and what people paste here is, by design, a secret.
		const token = `zq${Math.random().toString(36).slice(2, 12)}`
		const calls = countRemoteCalls(page)
		const panel = await openManage(page)

		await panel.getByPlaceholder(/DATABASE_URL=/).fill(`DATABASE_URL=postgres://app:${token}@db.internal:5432/app`)
		await panel.getByRole('button', { name: 'Check', exact: true }).click()
		await expect(panel.getByText(/Blocked by “Connection string credentials”/)).toBeVisible()

		const tester = calls.requests.filter((request) => remoteFunctionName(request)?.startsWith('testMemoryExclusionRules'))
		expect(tester.map((request) => request.method())).toEqual(['POST'])
		expect(tester[0].postData() ?? '', 'the sample is in the body').not.toBe('')
		for (const request of calls.requests) {
			expect(decodeURIComponent(request.url()), request.url()).not.toContain(token)
			expect(decodedUrlPayload(request.url()), request.url()).not.toContain(token)
		}
	})
})

test.describe('memory/palace-ui — exclusion rule list', () => {
	test('a rule saved before the editor refused slow patterns is flagged in the list', async ({ page }) => {
		const prefix = uniquePrefix('mem-ui-slow-rule')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into memory_exclusion_rules (user_id, name, kind, pattern, enabled)
				values (${userId}, ${`${prefix} slow`}, 'regex', '(a+)+$', false)
			`
			const panel = await openManage(page)
			const rule = panel.locator('li.rule').filter({ hasText: `${prefix} slow` })
			await expect(rule.locator('.rule__problem')).toContainText('repeats a group')
		} finally {
			await sql`delete from memory_exclusion_rules where name like ${`${prefix}%`}`
		}
	})
})
