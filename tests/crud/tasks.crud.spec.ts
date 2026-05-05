import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getActiveAdminUserId,
	getSql,
	pollDb,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /tasks + /tasks/[id] CRUD lifecycle.
 *
 * Tasks have no UI create form — they're created via `propose_plan` in chat
 * or by the orchestrator. We seed via SQL then exercise the status transition
 * + cancel buttons on /tasks/[id].
 */

test.describe('/tasks — CRUD lifecycle (status transitions + cancel)', () => {
	test('seed → list → detail → mark running → mark completed → cancel a separate task', async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-tasks')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveAdminUserId()

		const [task1] = await sql<{ id: string }[]>`
			insert into tasks (title, spec, status, created_by, priority)
			values (${`${prefix} task one`}, 'spec one', 'pending'::task_status, ${userId}, 5)
			returning id
		`
		const [task2] = await sql<{ id: string }[]>`
			insert into tasks (title, spec, status, created_by, priority)
			values (${`${prefix} task two`}, 'spec two', 'pending'::task_status, ${userId}, 4)
			returning id
		`

		try {
			await withErrorCapture(page, async () => {
				// ── Read /tasks list — task1 visible
				await page.goto('/tasks')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByText(`${prefix} task one`).first()).toBeVisible({ timeout: 8_000 })

				// ── Read /tasks/[id] for task1
				await page.goto(`/tasks/${task1.id}`)
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: `${prefix} task one` })).toBeVisible()

				// ── Update: pending → running
				await page.getByRole('button', { name: 'Mark running' }).click()
				await pollDb(
					() => sql<{ status: string }[]>`select status::text as status from tasks where id = ${task1.id}`,
					(rows) => rows[0]?.status === 'running',
					{ description: 'task transitioned to running' },
				)

				// ── Update: running → completed
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				await page.getByRole('button', { name: 'Mark completed' }).click()
				await pollDb(
					() => sql<{ status: string }[]>`select status::text as status from tasks where id = ${task1.id}`,
					(rows) => rows[0]?.status === 'completed',
					{ description: 'task transitioned to completed' },
				)

				// ── Cancel task2 (separate task — terminal-state cancel from pending)
				page.on('dialog', (d) => void d.accept())
				await page.goto(`/tasks/${task2.id}`)
				await page.waitForLoadState('domcontentloaded')
				await page.getByRole('button', { name: 'Cancel', exact: true }).click()
				await pollDb(
					() => sql<{ status: string }[]>`select status::text as status from tasks where id = ${task2.id}`,
					(rows) => rows[0]?.status === 'canceled',
					{ description: 'task2 canceled from pending' },
				)

				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
