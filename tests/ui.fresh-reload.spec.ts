import type { RemoteQuery } from '@sveltejs/kit'
import { expect, test, type Page } from '@playwright/test'
import { fetchFresh } from '../src/lib/ui/fresh-query'
import {
	answerConfirmDialog,
	authenticateContext,
	getActiveUserId,
	getSql,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * Pages that reload their data must get it from the server.
 *
 * A remote `query()` called again with the same arguments returns the value SvelteKit
 * cached the first time, and a page that first awaited it in `onMount` keeps that entry
 * alive while it is open. Every Refresh button below re-awaited its query and got back
 * what it already had; every post-mutation reload did the same, so a change landed in the
 * database and not on the screen. The existing specs asserted through the database only,
 * which is why none of this showed.
 *
 * Each case here changes the database *after* the page has loaded and then asks the page
 * to reload — the one sequence a cached read gets wrong.
 */

function slugOf(prefix: string) {
	return prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

async function clickRefresh(page: Page) {
	const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
	// Enabled means the first load has finished; a click before that proves nothing.
	await expect(refresh).toBeEnabled({ timeout: 15_000 })
	await refresh.click()
}

test.describe('fetchFresh', () => {
	test('refreshes the query before reading it, and surfaces a failed refresh', async () => {
		const calls: string[] = []
		let value = 'cached'
		const query = {
			refresh: async () => {
				calls.push('refresh')
				value = 'fresh'
			},
			then: (resolve: (v: string) => unknown, reject: (e: unknown) => unknown) => {
				calls.push('read')
				return Promise.resolve(value).then(resolve, reject)
			},
		} as unknown as RemoteQuery<string>

		expect(await fetchFresh(query)).toBe('fresh')
		expect(calls).toEqual(['refresh', 'read'])

		const failing = {
			refresh: async () => {
				throw new Error('offline')
			},
			then: (resolve: (v: string) => unknown) => Promise.resolve('stale').then(resolve),
		} as unknown as RemoteQuery<string>
		await expect(fetchFresh(failing)).rejects.toThrow('offline')
	})
})

test.describe('Refresh buttons fetch again', () => {
	test('/settings/jobs shows a job that failed after the page opened', async ({ page }) => {
		const prefix = uniquePrefix('fresh-jobs')
		const type = `e2e.refresh.${slugOf(prefix)}`
		const sql = getSql()
		await authenticateContext(page.context())
		try {
			await page.goto('/settings/jobs')
			await waitForHydration(page)
			await expect(page.getByText(type)).toHaveCount(0)

			// Inserted as already failed, so the in-process worker never picks it up.
			await sql`
				insert into jobs (type, status, payload, error, finished_at)
				values (${type}, 'failed', '{}'::jsonb, ${sql.json({ message: `${prefix} boom` })}, now())
			`
			await clickRefresh(page)
			await expect(page.getByText(type)).toBeVisible()
		} finally {
			await sql`delete from jobs where type = ${type}`
		}
	})

	test('/settings/hooks shows an invocation recorded after the page opened', async ({ page }) => {
		const prefix = uniquePrefix('fresh-hooks')
		const hookRef = `e2e-refresh-${slugOf(prefix)}`
		const sql = getSql()
		await authenticateContext(page.context())
		try {
			await page.goto('/settings/hooks')
			await waitForHydration(page)

			await sql`
				insert into hook_invocations (event, hook_kind, hook_ref, success, duration_ms)
				values ('after_run', 'builtin', ${hookRef}, true, 5)
			`
			await clickRefresh(page)
			await expect(page.getByText(hookRef)).toBeVisible()
		} finally {
			await sql`delete from hook_invocations where hook_ref = ${hookRef}`
		}
	})

	test('/audit shows an event recorded after the page opened', async ({ page }) => {
		const prefix = uniquePrefix('fresh-audit')
		const sql = getSql()
		const userId = await getActiveUserId()
		await authenticateContext(page.context())
		try {
			await page.goto('/audit')
			await waitForHydration(page)

			await sql`
				insert into audit_events (actor_user_id, action, summary)
				values (${userId}, 'settings.updated'::audit_action, ${`${prefix} audit row`})
			`
			await clickRefresh(page)
			await expect(page.getByText(`${prefix} audit row`)).toBeVisible()
		} finally {
			await sql`delete from audit_events where summary like ${`${prefix}%`}`
		}
	})

	test('/activity shows an event recorded after the page opened', async ({ page }) => {
		const prefix = uniquePrefix('fresh-activity')
		const sql = getSql()
		await authenticateContext(page.context())
		try {
			await page.goto('/activity')
			await waitForHydration(page)

			await sql`
				insert into activity_events (type, summary)
				values ('agent_action', ${`${prefix} activity row`})
			`
			await clickRefresh(page)
			await expect(page.getByText(`${prefix} activity row`)).toBeVisible()
		} finally {
			await sql`delete from activity_events where summary like ${`${prefix}%`}`
		}
	})

	test('/monitors shows a change made after the page opened', async ({ page }) => {
		const prefix = uniquePrefix('fresh-monitors')
		const sql = getSql()
		const userId = await getActiveUserId()
		await authenticateContext(page.context())
		try {
			// Paused, with its next check a day out, so the dispatcher never runs it.
			await sql`
				insert into monitors (user_id, name, status, condition_kind, condition, action, deadline_at, next_check_at)
				values (
					${userId},
					${`${prefix} before`},
					'paused',
					'tool_result',
					${sql.json({ kind: 'tool_result', tool: 'list_projects', args: {}, compare: 'changed' })},
					'review_item',
					now() + interval '1 day',
					now() + interval '1 day'
				)
			`
			await page.goto('/monitors')
			await waitForHydration(page)
			await expect(page.getByText(`${prefix} before`)).toBeVisible()

			await sql`update monitors set name = ${`${prefix} after`} where name = ${`${prefix} before`}`
			await clickRefresh(page)
			await expect(page.getByText(`${prefix} after`)).toBeVisible()
			await expect(page.getByText(`${prefix} before`)).toHaveCount(0)
		} finally {
			await sql`delete from monitors where name like ${`${prefix}%`}`
		}
	})

	test('/review/trace shows spans recorded after the page opened', async ({ page }) => {
		const prefix = uniquePrefix('fresh-trace')
		const sql = getSql()
		// `run_traces.run_id` has no foreign key, so a bare uuid is a valid run for the viewer.
		const [{ run_id: runId }] = await sql<{ run_id: string }[]>`
			insert into run_traces (run_id, status) values (gen_random_uuid(), 'running') returning run_id
		`
		const toolName = `e2e_probe_${slugOf(prefix).slice(-6)}`
		await authenticateContext(page.context())
		try {
			await page.goto(`/review/trace/${runId}`)
			await waitForHydration(page)
			await expect(page.getByText('running', { exact: true }).first()).toBeVisible()

			await sql`
				update run_traces
				set status = 'completed',
					finished_at = now(),
					tool_call_count = 1,
					trace = ${sql.json([{ seq: 1, kind: 'tool_call', toolName, startedAt: new Date().toISOString(), durationMs: 12, success: true }])}
				where run_id = ${runId}
			`
			await clickRefresh(page)
			await expect(page.getByText(toolName).first()).toBeVisible()
			await expect(page.getByText('completed', { exact: true }).first()).toBeVisible()
		} finally {
			await sql`delete from run_traces where run_id = ${runId}`
		}
	})
})

test.describe('reloads after a mutation show the result', () => {
	test('/review: a resolved inbox item leaves the open queue', async ({ page }) => {
		const prefix = uniquePrefix('fresh-review')
		const sql = getSql()
		const [item] = await sql<{ id: string }[]>`
			insert into review_items (type, severity, summary, payload)
			values ('automation_summary', 'info', ${`${prefix} weekly run`}, '{}'::jsonb)
			returning id
		`
		await authenticateContext(page.context())
		try {
			await page.goto('/review')
			await waitForHydration(page)
			const row = page.getByRole('button', { name: new RegExp(`${prefix} weekly run`) })
			await expect(row).toBeVisible({ timeout: 15_000 })
			await row.click()

			// Resolve asks for an optional note through `prompt()`.
			page.once('dialog', (dialog) => void dialog.accept(''))
			await page.getByRole('button', { name: 'Resolve', exact: true }).click()

			await expect
				.poll(async () => (await sql<{ status: string }[]>`select status::text from review_items where id = ${item.id}`)[0]?.status)
				.toBe('resolved')
			// The page's own reload must agree with the database: the item is no longer open,
			// and its Resolve button is not there to be clicked a second time.
			await expect(page.getByText(`${prefix} weekly run`)).toHaveCount(0)
		} finally {
			await sql`delete from review_items where summary like ${`${prefix}%`}`
		}
	})

	test('/agents/[id]/identity: unlinking shows the agent without a skill', async ({ page }) => {
		const prefix = uniquePrefix('fresh-identity')
		const sql = getSql()
		const [agent] = await sql<{ id: string }[]>`
			insert into agents (name, role, system_prompt, model)
			values (${`${prefix} agent`}, 'tester', 'You are a tester.', 'anthropic/claude-sonnet-4')
			returning id
		`
		const [skill] = await sql<{ id: string }[]>`
			insert into skills (name, description, content, tags, enabled)
			values (${`agent/${prefix}/identity`}, 'Identity prompt', ${`${prefix} identity body`}, ${sql.array(['agent-identity'])}, true)
			returning id
		`
		await sql`update agents set identity_skill_id = ${skill.id} where id = ${agent.id}`
		await authenticateContext(page.context())
		try {
			await page.goto(`/agents/${agent.id}/identity`)
			await waitForHydration(page)
			await expect(page.getByRole('button', { name: 'Unlink skill' })).toBeVisible()

			await page.getByRole('button', { name: 'Unlink skill' }).click()
			await answerConfirmDialog(page, 'Unlink')

			await expect(page.getByText('No identity skill linked')).toBeVisible()
			const [row] = await sql<{ identity_skill_id: string | null }[]>`
				select identity_skill_id from agents where id = ${agent.id}
			`
			expect(row.identity_skill_id).toBeNull()
		} finally {
			await sql`delete from agents where id = ${agent.id}`
			await sql`delete from skills where id = ${skill.id}`
		}
	})

	test('/research/[id]: the progress poll picks up a finished run', async ({ page }) => {
		const prefix = uniquePrefix('fresh-research')
		const sql = getSql()
		const userId = await getActiveUserId()
		// No job behind it, so nothing but this spec moves its status.
		const [research] = await sql<{ id: string }[]>`
			insert into research (user_id, query, status)
			values (${userId}, ${`${prefix} how do hydrofoils work`}, 'searching'::research_status)
			returning id
		`
		await authenticateContext(page.context())
		try {
			await page.goto(`/research/${research.id}`)
			await expect(page.getByText('searching…')).toBeVisible({ timeout: 15_000 })

			await sql`
				update research
				set status = 'complete'::research_status, report = ${`${prefix} final report`}, finished_at = now()
				where id = ${research.id}
			`
			// The view polls every 3s while a run is in flight. A cached poll re-read the
			// first snapshot forever, so the badge never left "searching" and the report
			// never appeared.
			await expect(page.getByText(`${prefix} final report`)).toBeVisible({ timeout: 15_000 })
			await expect(page.getByText('searching…')).toHaveCount(0)
		} finally {
			await sql`delete from research where query like ${`${prefix}%`}`
		}
	})
})
