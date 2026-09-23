import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * An `automation_run` job whose automation is gone or switched off is skipped, not failed.
 *
 * The case that mattered: a scheduled tick fails at 10:00 and its retry is queued for
 * 10:01. The user sees the failure and disables the automation at 10:00:30. At 10:01 the
 * retry used to throw "is disabled", and that throw went through the retry policy like any
 * other failure — one more retry queued, then the tick given up on: the failure streak
 * bumped, a `job_failure` review item opened and an "Automation run failed" notification
 * pushed, all for something the user had deliberately turned off.
 *
 * The handler body is driven directly (`executeAutomationRunJob`), against a job row of a
 * spec-only type so the test server's own worker can never claim it.
 */

async function insertSpecJob(prefix: string): Promise<string> {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into jobs (type, status) values (${`${prefix}-job`}, 'running'::job_status) returning id
	`
	return row.id
}

async function cleanup(prefix: string, automationId: string | null) {
	const sql = getSql()
	if (automationId) {
		await sql`delete from review_items where payload->>'automationId' = ${automationId}`
		await sql`delete from jobs where type = 'automation_run' and payload->>'automationId' = ${automationId}`
	}
	await sql`delete from jobs where type = ${`${prefix}-job`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
}

test.describe('automations/unavailable — a run for an automation that can no longer run', () => {
	test('a retry that lands after the user disabled the automation is skipped quietly', async () => {
		const prefix = uniquePrefix('automation-disabled-retry')
		const sql = getSql()
		const userId = await getActiveUserId()
		let automationId: string | null = null
		try {
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, enabled, next_run_at)
				values (
					${userId}, ${`${prefix} nightly digest`}, '0 9 * * *', ${`${prefix} summarize`},
					false, ${new Date(Date.now() - 60_000)}
				)
				returning id
			`
			automationId = automation.id
			const jobId = await insertSpecJob(prefix)

			const { executeAutomationRunJob } = await import('../src/lib/automations/automation-handler.server')
			const result = await executeAutomationRunJob({
				id: jobId,
				payload: { automationId, attempt: 2, trigger: 'schedule' },
			})

			expect(result.status).toBe('skipped')
			expect(result.reason).toBe('disabled')

			// No further retry was queued behind it.
			const { automationRetryDedupeKey } = await import('../src/lib/automations/failure-policy')
			const retries = await sql<{ id: string }[]>`
				select id from jobs where dedupe_key = ${automationRetryDedupeKey(jobId, automationId, 3)}
			`
			expect(retries, 'a skipped run queues no retry').toHaveLength(0)

			// Nothing counted it as a failure.
			const [row] = await sql<{ consecutive_failures: number; enabled: boolean; disabled_reason: string | null }[]>`
				select consecutive_failures, enabled, disabled_reason from automations where id = ${automationId}
			`
			expect(row.consecutive_failures).toBe(0)
			expect(row.enabled).toBe(false)
			expect(row.disabled_reason, 'still the user’s disable, not the failure policy’s').toBeNull()

			const items = await sql<{ id: string }[]>`
				select id from review_items where payload->>'automationId' = ${automationId}
			`
			expect(items, 'no failure review item for a deliberate disable').toHaveLength(0)

			const runs = await sql<{ id: string }[]>`select id from automation_runs where automation_id = ${automationId}`
			expect(runs, 'nothing ran, so the history has nothing to show').toHaveLength(0)
		} finally {
			await cleanup(prefix, automationId)
		}
	})

	test('a run for an automation that was deleted is skipped', async () => {
		const prefix = uniquePrefix('automation-deleted-run')
		const missingId = crypto.randomUUID()
		try {
			const jobId = await insertSpecJob(prefix)
			const { executeAutomationRunJob } = await import('../src/lib/automations/automation-handler.server')
			const result = await executeAutomationRunJob({
				id: jobId,
				payload: { automationId: missingId, attempt: 1, trigger: 'schedule' },
			})
			expect(result.status).toBe('skipped')
			expect(result.reason).toBe('not_found')

			const sql = getSql()
			const { automationRetryDedupeKey } = await import('../src/lib/automations/failure-policy')
			const retries = await sql<{ id: string }[]>`
				select id from jobs where dedupe_key = ${automationRetryDedupeKey(jobId, missingId, 2)}
			`
			expect(retries).toHaveLength(0)
		} finally {
			await cleanup(prefix, missingId)
		}
	})

	test('a monitor firing at a disabled automation falls back to a review item', async () => {
		// The job would skip the run, so the monitor checks first — otherwise the
		// observation would reach nobody.
		const prefix = uniquePrefix('monitor-disabled-automation')
		const sql = getSql()
		const userId = await getActiveUserId()
		let automationId: string | null = null
		let monitorId: string | null = null
		try {
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, enabled)
				values (${userId}, ${`${prefix} on-demand`}, '0 9 * * *', ${`${prefix} react`}, false)
				returning id
			`
			automationId = automation.id

			const { createMonitor } = await import('../src/lib/monitors/monitors.server')
			const monitor = await createMonitor({
				userId,
				name: `${prefix} watcher`,
				condition: { kind: 'tool_result', tool: 'web_fetch', args: { url: 'https://example.com' }, compare: 'changed' },
				action: 'run_automation',
				actionConfig: { automationId },
			})
			monitorId = monitor.id

			const { buildObservation } = await import('../src/lib/monitors/condition')
			const { dispatchMonitorAction } = await import('../src/lib/monitors/actions.server')
			const fired = await dispatchMonitorAction({ ...monitor, fireCount: 1 }, buildObservation('new value', true))

			expect(fired.ok).toBe(false)
			expect(fired.detail.fellBackTo).toBe('review_item')
			expect(String(fired.detail.error)).toContain('disabled')

			const queued = await sql<{ id: string }[]>`
				select id from jobs where type = 'automation_run' and payload->>'automationId' = ${automationId}
			`
			expect(queued, 'no run is queued for a disabled automation').toHaveLength(0)

			const items = await sql<{ severity: string }[]>`
				select severity::text as severity from review_items where payload->>'monitorId' = ${monitorId}
			`
			expect(items).toHaveLength(1)
			expect(items[0].severity).toBe('critical')
		} finally {
			if (monitorId) {
				await sql`delete from review_items where payload->>'monitorId' = ${monitorId}`
				await sql`delete from monitors where id = ${monitorId}`
			}
			await cleanup(prefix, automationId)
		}
	})
})
