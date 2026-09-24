import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedConversation,
	uniquePrefix,
} from './helpers'

/**
 * #35 — stopping one background task.
 *
 * The model has been able to background a `Bash` command since #15 (`run_in_background`,
 * stopped with `TaskStop`), and the SDK reports every live task through
 * `background_tasks_changed`. The missing direction was stopping one:
 * `Query.stopTask(id)` is a control request on the live session, which is only reachable
 * through the run registry.
 *
 * These cover the endpoint's gate rather than a real stop — a real one needs a live CLI
 * session with a backgrounded command in it, which is a live spec. The gate is the part
 * worth pinning anyway: the registry is keyed by run id alone and knows nothing about who
 * owns a run, so the endpoint is the only thing standing between a run id and a stranger's
 * session.
 */

async function seedRun(conversationId: string, opts: { finished: boolean }) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, started_at, finished_at)
		values (
			${conversationId},
			${userId},
			${opts.finished ? 'completed' : 'running'},
			'chat_stream',
			now(),
			${opts.finished ? sql`now()` : null}
		)
		returning id
	`
	return run.id
}

test.describe('chat/stop-task — the gate in front of Query.stopTask', () => {
	test('a live run with no handle in this process reports not reachable, not an error', async ({ page }) => {
		const prefix = uniquePrefix('stoptask-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id, { finished: false })

			const response = await page.request.post(`/chat/${conv.id}/stop-task`, {
				data: { runId, taskId: 'bash_1' },
			})

			// Not a 500 and not a lie: the run row is real and active, but no `query()` in
			// this process is holding it, which is exactly what the registry's `false` means.
			expect(response.status()).toBe(200)
			expect(await response.json()).toEqual({ stopped: false, reason: 'not_reachable' })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a finished run is refused — its tasks are the CLI\'s to clean up', async ({ page }) => {
		const prefix = uniquePrefix('stoptask-finished')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const userId = await getActiveUserId()
			const conv = await seedConversation(prefix, { userId })
			const runId = await seedRun(conv.id, { finished: true })

			const response = await page.request.post(`/chat/${conv.id}/stop-task`, {
				data: { runId, taskId: 'bash_1' },
			})
			expect(await response.json()).toEqual({ stopped: false, reason: 'run_not_active' })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a run id from another conversation does not reach the registry', async ({ page }) => {
		// The check that matters: the registry is keyed by run id alone, so a caller who
		// learns one must not be able to stop its tasks by pointing a conversation they do
		// own at it.
		const prefix = uniquePrefix('stoptask-foreign')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const userId = await getActiveUserId()
			const mine = await seedConversation(prefix, { userId })
			const other = await seedConversation(`${prefix}-other`, { userId })
			const foreignRunId = await seedRun(other.id, { finished: false })

			const response = await page.request.post(`/chat/${mine.id}/stop-task`, {
				data: { runId: foreignRunId, taskId: 'bash_1' },
			})
			expect(await response.json()).toEqual({ stopped: false, reason: 'run_not_active' })
		} finally {
			await cleanupPrefixedRecords(prefix)
			await cleanupPrefixedRecords(`${prefix}-other`)
		}
	})

	test('a request missing either id is a 400, not a silent no-op', async ({ page }) => {
		const prefix = uniquePrefix('stoptask-bad')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
			for (const data of [{ taskId: 'bash_1' }, { runId: '00000000-0000-0000-0000-000000000000' }, {}]) {
				const response = await page.request.post(`/chat/${conv.id}/stop-task`, { data })
				expect(response.status(), JSON.stringify(data)).toBe(400)
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an unauthenticated request never reaches the registry', async ({ playwright }) => {
		// `maxRedirects: 0` on purpose: the app sends an anonymous request to the login page,
		// and a followed redirect answers 200 with HTML — which would read as a pass here
		// while proving nothing about the endpoint.
		const context = await playwright.request.newContext()
		try {
			const response = await context.post('/chat/00000000-0000-0000-0000-000000000000/stop-task', {
				data: { runId: '00000000-0000-0000-0000-000000000000', taskId: 'bash_1' },
				maxRedirects: 0,
			})
			expect([401, 302, 303]).toContain(response.status())
		} finally {
			await context.dispose()
		}
	})
})
