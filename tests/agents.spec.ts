import { expect, test } from '@playwright/test'
import * as devalue from 'devalue'
import {
	acquireGlobalStateLock,
	authenticateContext,
	cleanupPrefixedRecords,
	getBuiltinChatAgentId,
	getSql,
	pollDb,
	seedAgent,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { listRemoteFunctions } from './remote-functions'

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
 * What this file used to assert, and what it covers now.
 *
 * It drove a create-agent *form* at /agents/new, then paused and re-activated the agent
 * from its detail page, then queued a task and delegated it to a second agent. Only one of
 * those affordances is back:
 *
 *   - /agents/new is a redirector that opens a guided creation chat. There is no form, and
 *     the guided flow cannot be driven here without a live model run.
 *   - Pause and Resume are back (#66), as a two-state control: Available or Paused. Paused
 *     means "not offered for delegation, and not run by automations or monitors"; idle and
 *     active both read as Available. It is on the detail page and inline on the list, for
 *     agents the user created — built-ins and evaluators have no control.
 *   - `agent_tasks` was dropped in migration 0004, so the queue/delegate half of this file
 *     had been asserting against a table that has not existed for a long time.
 *
 * What the status *means* is pinned without a browser in agents.status.spec.ts and
 * automations.paused-agent.spec.ts. This file pins that the pages show it and change it,
 * and that Back from the guided creation chat gets past /agents/new. The pages staying up
 * while an agent streams is agents.live-stream.spec.ts.
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

async function agentStatus(agentId: string) {
	const [row] = await getSql()<{ status: string }[]>`select status::text as status from agents where id = ${agentId}`
	return row?.status ?? null
}

test('the detail page shows a paused agent, and resumes and pauses it', async ({ page }) => {
	const prefix = uniquePrefix('agent-detail')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const sql = getSql()

	const agent = await seedAgent(prefix, { name: `${prefix} Primary`, status: 'paused' })
	try {
		await page.goto(`/agents/${agent.id}`)
		await waitForHydration(page)

		// The name appears twice by design: PageHeader's <h1> and the hero card's <h2>.
		await expect(page.getByRole('heading', { name: `${prefix} Primary`, level: 1 })).toBeVisible()
		await expect(page.getByRole('heading', { name: `${prefix} Primary`, level: 2 })).toBeVisible()
		// Seeded paused rather than the helper's default idle, so a hardcoded badge fails. The
		// page says what that means, because "paused" alone suggests more than it does.
		await expect(page.getByText('Paused', { exact: true }).filter({ visible: true }).first()).toBeVisible()
		await expect(page.getByRole('note').filter({ hasText: 'still chat with them directly' })).toBeVisible()

		await page.getByRole('button', { name: 'Resume', exact: true }).click()
		await pollDb(() => agentStatus(agent.id), (s) => s === 'active', { description: 'agent resumed' })
		await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
		await expect(page.getByText('Available', { exact: true }).filter({ visible: true }).first()).toBeVisible()
		await expect(page.getByRole('note')).toHaveCount(0)

		// Recorded in the audit trail, with who did it — the setter used to write null.
		const audit = await pollDb(
			() => sql<{ actor_user_id: string | null }[]>`
				select actor_user_id from audit_events
				where action = 'agent.status.changed' and target_id = ${agent.id}
			`,
			(rows) => rows.length === 1,
			{ description: 'status audit row' },
		)
		expect(audit[0].actor_user_id).not.toBeNull()

		await page.getByRole('button', { name: 'Pause', exact: true }).click()
		await pollDb(() => agentStatus(agent.id), (s) => s === 'paused', { description: 'agent paused again' })
		await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
	} finally {
		await sql`delete from audit_events where target_id = ${agent.id}`
		await cleanupPrefixedRecords(prefix)
	}
})

test('a built-in agent has no Pause control, and the server refuses one anyway', async ({ page, baseURL }) => {
	await authenticateContext(page.context())
	const chatId = await getBuiltinChatAgentId()
	const before = await agentStatus(chatId)

	await page.goto(`/agents/${chatId}`)
	await waitForHydration(page)
	await expect(page.getByText('Built-in', { exact: true }).filter({ visible: true }).first()).toBeVisible()
	await expect(page.getByRole('button', { name: /^(Pause|Resume)$/ })).toHaveCount(0)

	// Hidden is not refused. A hand-made call to the command gets a 400 and changes nothing.
	const command = listRemoteFunctions().find(
		(fn) => fn.file === 'src/lib/agents/agents.remote.ts' && fn.name === 'setAgentPausedCommand',
	)!
	const payload = Buffer.from(devalue.stringify({ agentId: chatId, paused: true })).toString('base64url')
	const response = await page.request.post(`/_app/remote/${command.id}`, {
		headers: { origin: baseURL!, 'content-type': 'application/json', 'x-sveltekit-pathname': `/agents/${chatId}` },
		data: JSON.stringify({ payload, refreshes: [] }),
	})
	const body = (await response.json()) as { type: string; status?: number; error?: { message?: string } }
	expect(body).toMatchObject({ type: 'error', status: 400 })
	expect(body.error?.message).toMatch(/Built-in agents cannot be paused/)
	expect(await agentStatus(chatId)).toBe(before)
})

test('the list pauses and resumes an agent inline', async ({ page }) => {
	const prefix = uniquePrefix('agent-list')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const name = `${prefix} Inline`
	const agent = await seedAgent(prefix, { name, status: 'idle' })
	try {
		await page.goto('/agents')
		await waitForHydration(page)
		const card = page.locator('article', { hasText: name })

		// Idle and active are the same thing to a user: available.
		await expect(card.getByText('Available', { exact: true })).toBeVisible()
		await card.getByRole('button', { name: `Pause ${name}` }).click()
		await pollDb(() => agentStatus(agent.id), (s) => s === 'paused', { description: 'agent paused from the list' })
		await expect(card.getByText('Paused', { exact: true })).toBeVisible()

		await card.getByRole('button', { name: `Resume ${name}` }).click()
		await pollDb(() => agentStatus(agent.id), (s) => s === 'active', { description: 'agent resumed from the list' })
		await expect(card.getByText('Available', { exact: true })).toBeVisible()
	} finally {
		await getSql()`delete from audit_events where target_id = ${agent.id}`
		await cleanupPrefixedRecords(prefix)
	}
})
