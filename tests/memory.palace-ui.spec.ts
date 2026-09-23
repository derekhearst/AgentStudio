import { expect, test, type Page, type Request, type Route } from '@playwright/test'
// SvelteKit's own wire format for remote-function results; used to answer a few calls in
// place of the server where letting them through would touch other specs' data.
import { stringify } from 'devalue'
import {
	acquireGlobalStateLock,
	authenticateContext,
	getActiveUserId,
	getSql,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { noModelCredentialsRequested } from './server-env'

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

/**
 * Answer calls to one remote function with `value`, as the server would.
 *
 * A command's caller reads the result from `_`. A query's does not: the client files a query's
 * value from the single-flight map `q`, keyed by `<hash>/<name>/<payload>`, and a response
 * without it leaves the query resolved to `undefined`. So a query (a GET) gets both.
 */
async function answerRemote(page: Page, name: string, value: unknown, onCall?: () => void) {
	await page.route(new RegExp(`/_app/remote/[^/]+/${name}(\\?|$)`), (route: Route) => {
		onCall?.()
		const request = route.request()
		const data: Record<string, unknown> = { _: value }
		if (request.method() === 'GET') {
			const url = new URL(request.url())
			const id = url.pathname.slice(url.pathname.indexOf('/_app/remote/') + '/_app/remote/'.length)
			data.q = { [`${id}/${url.searchParams.get('payload') ?? ''}`]: { v: value } }
		}
		return route.fulfill({ json: { type: 'result', data: stringify(data) } })
	})
}

/** Fail calls to one remote function the way the server does when a handler throws. */
async function failRemote(page: Page, name: string) {
	await page.route(new RegExp(`/_app/remote/[^/]+/${name}(\\?|$)`), (route: Route) =>
		route.fulfill({ status: 500, json: { type: 'error', status: 500, error: { message: 'Database unavailable' } } }),
	)
}

async function openMemory(page: Page) {
	await page.goto('/memory')
	await waitForHydration(page)
}

async function openManage(page: Page) {
	await openMemory(page)
	await page.getByRole('button', { name: 'Manage', exact: true }).click()
	const panel = page.getByRole('dialog', { name: 'Memory management' })
	await expect(panel).toBeVisible()
	await expect(panel.locator('.loading-spinner')).toHaveCount(0)
	return panel
}

/** Open a wing from the list view. */
async function openWing(page: Page, name: string) {
	await openMemory(page)
	await page.getByRole('button', { name: 'List', exact: true }).click()
	await page.locator('.wing-list__item').filter({ hasText: name }).first().click()
}

/** wing → room → closet → drawer under `prefix`. */
async function seedPalace(prefix: string, options: { withCloset: boolean }) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [wing] = await sql<{ id: string }[]>`
		insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} wing`}, ${`${prefix}-wing`})
		returning id
	`
	const [room] = await sql<{ id: string }[]>`
		insert into memory_rooms (wing_id, label) values (${wing.id}, ${`${prefix} room`}) returning id
	`
	if (!options.withCloset) return { wingId: wing.id, roomId: room.id, drawerId: null }
	const [closet] = await sql<{ id: string }[]>`
		insert into memory_closets (room_id, topic) values (${room.id}, 'battery') returning id
	`
	const [drawer] = await sql<{ id: string }[]>`
		insert into memory_drawers (closet_id, user_id, content, token_count)
		values (${closet.id}, ${userId}, ${`${prefix} we chose the 48V battery`}, 6)
		returning id
	`
	return { wingId: wing.id, roomId: room.id, drawerId: drawer.id }
}

async function cleanupPalace(prefix: string) {
	const sql = getSql()
	await sql`delete from memory_wings where name like ${`${prefix}%`}`
	await sql`delete from memory_exclusion_rules where name like ${`${prefix}%`}`
}

const IDLE_STATS = {
	wingCount: 0,
	drawerCount: 0,
	tokenSum: 0,
	roomCount: 0,
	lastTouchedAt: null,
	lastMinedAt: null,
	conversationCount: 0,
	minedConversationCount: 0,
	drawersWithEmbedding: 0,
	embeddingCoverage: 1,
	pendingMineJobs: 0,
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
		try {
			// Disabled, so it runs on nobody else's turns while this spec is up.
			await getSql()`
				insert into memory_exclusion_rules (user_id, name, kind, pattern, enabled)
				values (${userId}, ${`${prefix} slow`}, 'regex', '(a+)+$', false)
			`
			const panel = await openManage(page)
			const rule = panel.locator('li.rule').filter({ hasText: `${prefix} slow` })
			await expect(rule.locator('.rule__problem')).toContainText('repeats a group')
		} finally {
			await cleanupPalace(prefix)
		}
	})

	test('editing a disabled rule leaves it disabled', async ({ page }) => {
		// Save always sent `enabled: true`, so rewording a rule the user had switched off
		// switched it back on without a word.
		const prefix = uniquePrefix('mem-ui-edit-rule')
		const userId = await getActiveUserId()
		const sql = getSql()
		// Saving a rule releases the turns other specs set aside (memory.exclusion-scan.spec.ts).
		const release = await acquireGlobalStateLock('memory-exclusion-rule-changes')
		try {
			await sql`
				insert into memory_exclusion_rules (user_id, name, kind, pattern, enabled)
				values (${userId}, ${`${prefix} rule`}, 'substring', ${`${prefix} never said`}, false)
			`
			const panel = await openManage(page)
			await panel.locator('li.rule').filter({ hasText: `${prefix} rule` }).getByRole('button', { name: 'Edit' }).click()
			await panel.getByPlaceholder('Optional description').fill('reworded')
			await panel.getByRole('button', { name: 'Save rule' }).click()
			await expect(panel.getByRole('button', { name: 'Add rule' })).toBeVisible()

			const [row] = await sql<{ enabled: boolean; description: string | null }[]>`
				select enabled, description from memory_exclusion_rules where name = ${`${prefix} rule`}
			`
			expect(row).toEqual({ enabled: false, description: 'reworded' })
		} finally {
			await cleanupPalace(prefix)
			await release()
		}
	})
})

test.describe('memory/palace-ui — rooms and drawers', () => {
	test('an empty room is asked for its closets once, and says it is empty', async ({ page }) => {
		// The room's effect reloaded whenever it had no closets and was not loading — and a
		// finished load is exactly that, so an empty room reloaded in a tight loop.
		const prefix = uniquePrefix('mem-ui-empty-room')
		try {
			await seedPalace(prefix, { withCloset: false })
			const calls = countRemoteCalls(page)
			await openWing(page, `${prefix} wing`)
			await expect(page.getByText('No closets in this room.')).toBeVisible()

			const settled = calls.count('listMemoryClosetsQuery')
			await page.waitForTimeout(2_000)
			expect(calls.count('listMemoryClosetsQuery'), 'no reload loop').toBe(settled)
			expect(settled).toBeLessThanOrEqual(2)
		} finally {
			await cleanupPalace(prefix)
		}
	})

	test('the re-embedding warning stays after the drawer reloads', async ({ page }) => {
		// The panel reset its edit state whenever the drawer object changed, and the page hands
		// it a fresh object after every save — so the warning vanished as it appeared.
		test.skip(!noModelCredentialsRequested(), 'needs the embedding call to fail, as it does with no model credential')
		const prefix = uniquePrefix('mem-ui-embed-warning')
		try {
			await seedPalace(prefix, { withCloset: true })
			await openWing(page, `${prefix} wing`)
			await page.locator('.drawer-card').filter({ hasText: `${prefix} we chose` }).first().click()

			await page.getByRole('button', { name: 'Edit', exact: true }).click()
			await page.getByRole('textbox', { name: 'Drawer content' }).fill(`${prefix} we chose the 24V battery`)
			await page.getByRole('button', { name: 'Save', exact: true }).click()

			const warning = page.locator('.drawer-detail__warn')
			await expect(warning).toContainText('re-embedding failed')
			// Long after the page has re-read the drawer.
			await page.waitForTimeout(3_000)
			await expect(warning).toContainText('re-embedding failed')
		} finally {
			await cleanupPalace(prefix)
		}
	})
})

test.describe('memory/palace-ui — Mine pending', () => {
	test('clicking it twice leaves no poller running', async ({ page }) => {
		// A second click overwrote the first poller's handle; whichever stopped first cleared
		// the other, and the first ran every 2 seconds for the life of the tab.
		// Answered here rather than by the server: really queueing "Mine pending" would enqueue
		// jobs for every other spec's conversations.
		let statsCalls = 0
		await answerRemote(page, 'mineAllPendingCommand', {
			conversationsScanned: 0,
			alreadyMined: 0,
			enqueued: 0,
			alreadyQueued: 0,
			skipped: 0,
		})
		await answerRemote(page, 'getMemoryStatsQuery', IDLE_STATS, () => (statsCalls += 1))
		await openMemory(page)

		const button = page.getByTitle(/Sweep all your conversations/)
		await button.click()
		await expect(button).toHaveText('Mine pending')
		await button.click()
		await expect(button).toHaveText('Mine pending')

		// Nothing is pending, so a poller stops on its first tick, two seconds in.
		await page.waitForTimeout(5_000)
		const before = statsCalls
		await page.waitForTimeout(6_000)
		expect(statsCalls - before, 'no stats polling once both pollers have stopped').toBe(0)
	})
})

test.describe('memory/palace-ui — Reorganize', () => {
	test('a failed analysis is shown and waits for the user, instead of retrying in a loop', async ({ page }) => {
		const calls = countRemoteCalls(page)
		await failRemote(page, 'analyzeMemoryReorganizationQuery')
		await openMemory(page)

		await page.getByRole('button', { name: 'Reorganize', exact: true }).click()
		const panel = page.getByRole('dialog', { name: 'Reorganize memory palace' })
		const retry = panel.getByRole('button', { name: 'Try again' })
		await expect(retry).toBeVisible()

		const settled = calls.count('analyzeMemoryReorganizationQuery')
		await page.waitForTimeout(2_000)
		expect(calls.count('analyzeMemoryReorganizationQuery'), 'no retry loop').toBe(settled)
		await expect(retry).toBeVisible()

		await retry.click()
		await expect(retry).toBeVisible()
		expect(calls.count('analyzeMemoryReorganizationQuery')).toBeGreaterThan(settled)
	})
})
