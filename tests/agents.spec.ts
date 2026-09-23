import { expect, test } from '@playwright/test'
import {
	acquireGlobalStateLock,
	authenticateContext,
	cleanupPrefixedRecords,
	getSql,
	seedAgent,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * Takes the same lock the budget specs use. Anything that runs the model has to: a
 * budget spec installing a $0.01 cap while this streams turns it into a 402 that looks
 * like a product failure. See `acquireGlobalStateLock` in helpers.
 */
let releaseBudgetLock: (() => Promise<void>) | null = null
test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
})
test.afterEach(async () => {
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

/**
 * What this file used to assert, and why it no longer can.
 *
 * It drove a create-agent *form* at /agents/new, then paused and re-activated the agent
 * from its detail page, then queued a task and delegated it to a second agent. All four
 * of those affordances are gone:
 *
 *   - /agents/new is now a redirector that opens a guided creation chat. There is no form.
 *   - The detail page is a read-only dashboard; it has no pause or activate control.
 *   - `agent_tasks` was dropped in migration 0004, so the queue/delegate half of this file
 *     had been asserting against a table that has not existed for a long time.
 *
 * Two things are worth saying plainly rather than quietly deleting. Agent `status` is
 * still rendered in three places — the list dot, the list badge and the detail badge —
 * and nothing in the UI can change it; pausing an agent now requires editing the
 * database. And the guided creation flow cannot be driven here without a live model run,
 * which is what `LIVE_SPECS` exists to keep out of CI.
 *
 * So this covers what is actually reachable: the redirect, and the detail page rendering
 * a real agent.
 */

test('agents/new opens a guided creation chat rather than a form', async ({ page }) => {
	await authenticateContext(page.context())

	await page.goto('/agents/new')

	// `startGuidedCreationChat` creates a conversation and navigates to it with the opening
	// prompt in the query string. The redirect is the whole behaviour of this route.
	await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 30_000 })
	expect(page.url()).toMatch(/\/chat\/[0-9a-f-]+/)
})

/**
 * /agents/new used to push the chat on top of itself. Back from the chat then landed on
 * /agents/new, which created another conversation, started another model run and jumped
 * forward again — Back could never get past it, and every attempt cost a run.
 */
test('Back from the guided creation chat returns to where you came from', async ({ page }) => {
	const sql = getSql()
	await authenticateContext(page.context())
	// Counted from this page's own traffic, not by title in the database: other specs (and
	// this file's run in the other project) open /agents/new too, and a count by title would
	// include, then delete, their conversations.
	let creates = 0
	page.on('request', (request) => {
		if (request.method() === 'POST' && /\/_app\/remote\/[^/]+\/createConversation$/.test(new URL(request.url()).pathname)) creates++
	})
	const chatIds = new Set<string>()
	page.on('framenavigated', (frame) => {
		const id = frame === page.mainFrame() ? /\/chat\/([0-9a-f-]+)/.exec(new URL(frame.url()).pathname)?.[1] : undefined
		if (id) chatIds.add(id)
	})

	try {
		await page.goto('/agents')
		await waitForHydration(page)
		await page.goto('/agents/new')
		await page.waitForURL(/\/chat\/[0-9a-f-]+/, { timeout: 30_000 })

		await page.goBack()
		await expect(page).toHaveURL(/\/agents$/)
		// Give a re-mounted /agents/new every chance to fire before counting.
		await page.waitForTimeout(1_500)
		await expect(page).toHaveURL(/\/agents$/)
		expect(creates).toBe(1)
	} finally {
		for (const id of chatIds) await sql`delete from conversations where id = ${id}`
	}
})

test('the agent detail page renders the agent', async ({ page }) => {
	const prefix = uniquePrefix('agent-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())

	try {
		const agent = await seedAgent(prefix, { name: `${prefix} Primary`, status: 'paused' })

		await page.goto(`/agents/${agent.id}`)

		// The name appears twice by design: PageHeader's <h1> and the hero card's <h2>.
		await expect(page.getByRole('heading', { name: `${prefix} Primary`, level: 1 })).toBeVisible()
		await expect(page.getByRole('heading', { name: `${prefix} Primary`, level: 2 })).toBeVisible()
		// The status badge is read-only — nothing in the UI can change it — but it should at
		// least report what the database says. Seeded as 'paused' rather than the helper's
		// default 'idle' so the assertion would fail on a hardcoded badge.
		await expect(page.getByText('paused', { exact: true }).filter({ visible: true }).first()).toBeVisible()
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
