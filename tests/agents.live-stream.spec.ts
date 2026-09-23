import { expect, test, type Page } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedAgent,
	seedConversation,
	uniquePrefix,
} from './helpers'

/**
 * The agents pages while an agent is actually running.
 *
 * Both pages subscribe to /api/agents/monitor, which streams the active chat_runs rows
 * for agents. Each page used to declare its own shape for those rows, and both got it
 * wrong the same way: they read `delta`, the monitor sends `lastDelta`, and it is null
 * until the first token. /agents was fixed first; /agents/[id] kept throwing on
 * `undefined.length` the moment its agent streamed — exactly when the page is meant to
 * show it.
 *
 * No model is needed: a `running` chat_runs row bound to the agent is what the monitor
 * reports, so the spec seeds one and moves `last_delta` itself.
 */

async function seedRunningRun(prefix: string) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const agent = await seedAgent(prefix, { name: `${prefix} Streamer`, status: 'active' })
	const conversation = await seedConversation(prefix, { agentId: agent.id, userId })
	// `last_delta` left null on purpose: a run that has started but not produced a token
	// yet is the first thing the page sees, and it is the case that crashed.
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, agent_id, state, source, label, started_at)
		values (${conversation.id}, ${userId}, ${agent.id}, 'running', 'chat_stream', ${`${prefix} run`}, now())
		returning id
	`
	return { agent, conversation, runId: run.id }
}

async function setLastDelta(runId: string, text: string) {
	const sql = getSql()
	await sql`update chat_runs set last_delta = ${text}, updated_at = now() where id = ${runId}`
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from chat_runs where label like ${`${prefix}%`}`
	await cleanupPrefixedRecords(prefix)
}

function collectPageErrors(page: Page) {
	const errors: string[] = []
	page.on('pageerror', (err) => errors.push(err.message))
	return errors
}

test.describe('agents — live stream preview', () => {
	test('the detail page shows a running agent instead of crashing', async ({ page }) => {
		const prefix = uniquePrefix('agent-live-detail')
		await cleanup(prefix)
		await authenticateContext(page.context())
		const errors = collectPageErrors(page)

		try {
			const { agent, conversation, runId } = await seedRunningRun(prefix)

			await page.goto(`/agents/${agent.id}`)
			await expect(page.getByRole('heading', { name: `${prefix} Streamer`, level: 1 })).toBeVisible()

			// The monitor polls every 700ms; the banner appears with the first snapshot.
			await expect(page.getByText('Currently streaming')).toBeVisible({ timeout: 10_000 })
			await expect(page.getByRole('link', { name: 'Watch live →' })).toHaveAttribute(
				'href',
				`/chat/${conversation.id}`,
			)

			// Then the first tokens land, and the page keeps up rather than having died.
			await setLastDelta(runId, `${prefix} partial reply`)
			await expect(page.getByText(`${prefix} partial reply`)).toBeVisible({ timeout: 10_000 })

			expect(errors).toEqual([])
		} finally {
			await cleanup(prefix)
		}
	})

	test('the agents list shows a running agent with its latest text', async ({ page }) => {
		const prefix = uniquePrefix('agent-live-list')
		await cleanup(prefix)
		await authenticateContext(page.context())
		const errors = collectPageErrors(page)

		try {
			const { runId } = await seedRunningRun(prefix)

			await page.goto('/agents')
			const card = page.locator('article').filter({ hasText: `${prefix} Streamer` })
			await expect(card.getByText('Streaming live')).toBeVisible({ timeout: 10_000 })

			await setLastDelta(runId, `${prefix} list reply`)
			await expect(card.getByText(`${prefix} list reply`)).toBeVisible({ timeout: 10_000 })

			expect(errors).toEqual([])
		} finally {
			await cleanup(prefix)
		}
	})
})
