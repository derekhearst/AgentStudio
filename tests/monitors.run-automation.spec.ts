import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'
import { createMonitor, findOwnedAutomation, updateMonitorSettings } from '../src/lib/monitors/monitors.server'
import { dispatchMonitorAction, monitorAutomationJob } from '../src/lib/monitors/actions.server'
import { runAutomationById } from '../src/lib/automations/engine'

/**
 * #33 follow-up — a `run_automation` monitor fires only its owner's automation, and does not
 * disturb that automation's schedule.
 *
 * `actionConfig.automationId` was validated as "a UUID" and nothing else, and the job handler
 * runs an automation by id, as the automation's owner. So a monitor could name any
 * automation — someone else's, on their budget — and nothing noticed until it fired. The id
 * is now checked against the monitor owner when the monitor is saved and again when it fires.
 *
 * The enqueued job also carried no trigger, so it ran as `schedule` and every firing moved
 * the automation's `nextRunAt`. It carries `trigger: 'monitor'` now: the schedule is left
 * alone, but — unlike "Run now" — a switched-off automation is not run and a failure is
 * escalated, because nobody is watching a monitor-fired run.
 *
 * The monitors created here use a `changed` condition, whose first check only records a
 * baseline — so the scheduler cannot fire one in the moment before cleanup.
 */

const CONDITION = { kind: 'tool_result' as const, tool: 'list_projects' as const, args: {}, compare: 'changed' as const }

async function seedAutomation(userId: string, prefix: string): Promise<string> {
	const sql = getSql()
	// Disabled and due far in the future: nothing should run it for real.
	const [row] = await sql<{ id: string }[]>`
		insert into automations (user_id, description, cron_expression, prompt, enabled, next_run_at)
		values (${userId}, ${`${prefix} target`}, '0 9 * * *', ${`${prefix} prompt`}, false, now() + interval '365 days')
		returning id
	`
	return row.id
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from monitors where name like ${`${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
}

test.describe('monitors/run_automation — only the owner’s automation', () => {
	test('a monitor naming an automation that is not yours is refused when it is created', async () => {
		const prefix = uniquePrefix('monitor-foreign-automation')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await expect(
				createMonitor({
					userId,
					name: `${prefix} foreign`,
					condition: CONDITION,
					action: 'run_automation',
					actionConfig: { automationId: randomUUID() },
				}),
			).rejects.toThrow(/not found/)
			expect(await sql`select id from monitors where name like ${`${prefix}%`}`).toHaveLength(0)
		} finally {
			await cleanup(prefix)
		}
	})

	test('your own automation is accepted, and cannot be swapped for another afterwards', async () => {
		const prefix = uniquePrefix('monitor-own-automation')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const automationId = await seedAutomation(userId, prefix)
			const monitor = await createMonitor({
				userId,
				name: `${prefix} own`,
				condition: CONDITION,
				action: 'run_automation',
				actionConfig: { automationId },
			})
			expect(monitor.actionConfig.automationId).toBe(automationId)

			await expect(updateMonitorSettings(userId, monitor.id, { actionConfig: { automationId: randomUUID() } })).rejects.toThrow(
				/not found/,
			)
			const [stored] = await sql<{ action_config: { automationId?: string } }[]>`
				select action_config from monitors where id = ${monitor.id}
			`
			expect(stored.action_config.automationId).toBe(automationId)
		} finally {
			await cleanup(prefix)
		}
	})

	test('ownership is by user, so the same id is not found for anyone else', async () => {
		const prefix = uniquePrefix('monitor-other-user')
		const userId = await getActiveUserId()
		try {
			const automationId = await seedAutomation(userId, prefix)
			expect(await findOwnedAutomation(userId, automationId)).toEqual({ id: automationId, enabled: false })
			// The users table holds one owner, so "someone else" is an id that is not theirs.
			expect(await findOwnedAutomation(randomUUID(), automationId)).toBeNull()
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('monitors/run_automation — the job it enqueues', () => {
	test('is a monitor-triggered run, not a scheduled tick or a "Run now"', () => {
		const monitor = { id: randomUUID(), userId: randomUUID(), fireCount: 3 }
		const automationId = randomUUID()
		const job = monitorAutomationJob(monitor, automationId)
		expect(job.type).toBe('automation_run')
		expect(job.payload).toEqual({ automationId, attempt: 1, trigger: 'monitor' })
		expect(job.userId).toBe(monitor.userId)
		// One job per firing: a re-delivered check collapses, the next firing does not.
		expect(job.dedupeKey).toBe(`monitor_fire:${monitor.id}:3`)
	})
})

test.describe('monitors/run_automation — the off switch holds', () => {
	test('a monitor firing at a switched-off automation does not run it, and says so', async () => {
		const prefix = uniquePrefix('monitor-disabled-automation')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const automationId = await seedAutomation(userId, prefix) // seeded disabled
			const monitor = await createMonitor({
				userId,
				name: `${prefix} off switch`,
				condition: CONDITION,
				action: 'run_automation',
				actionConfig: { automationId },
			})
			const observation = { value: `${prefix} observed`, hash: 'h', observedAt: new Date().toISOString(), met: true }

			const result = await dispatchMonitorAction(monitor, observation)
			expect(result.ok).toBe(false)
			expect(String(result.detail.error)).toMatch(/switched off/)
			// Nothing was queued for it…
			const jobs = await sql`select id from jobs where type = 'automation_run' and payload->>'automationId' = ${automationId}`
			expect(jobs).toHaveLength(0)
			// …and the owner hears about it, once for this firing, so the observation is not lost.
			expect(result.detail.fellBackTo).toBe('review_item')
			const items = await sql<{ summary: string; severity: string }[]>`
				select summary, severity::text as severity from review_items where summary like ${`%${prefix}%`}
			`
			expect(items).toHaveLength(1)
			expect(items[0].summary).toContain('run_automation action failed')
			expect(items[0].severity).toBe('critical')
		} finally {
			await sql`delete from review_items where summary like ${`%${prefix}%`}`
			await cleanup(prefix)
		}
	})

	test('the engine refuses a monitor-triggered run of a switched-off automation, schedule untouched', async () => {
		// The race the fire-time check cannot close: switched off after the job was queued.
		const prefix = uniquePrefix('monitor-engine-disabled')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const automationId = await seedAutomation(userId, prefix)
			const [before] = await sql<{ next_run_at: Date }[]>`select next_run_at from automations where id = ${automationId}`
			await expect(runAutomationById(automationId, new Date(), { trigger: 'monitor' })).rejects.toThrow(/disabled/)
			const [after] = await sql<{ next_run_at: Date; last_run_at: Date | null }[]>`
				select next_run_at, last_run_at from automations where id = ${automationId}
			`
			expect(after.next_run_at.getTime()).toBe(before.next_run_at.getTime())
			expect(after.last_run_at).toBeNull()
			const runs = await sql`select id from automation_runs where automation_id = ${automationId}`
			expect(runs).toHaveLength(0)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a failed monitor-fired run is retried as a monitor run, and giving up leaves the schedule alone', () => {
		// The failure path is not exported; pin its wiring the way the dev-bypass spec does.
		const handler = readFileSync(join(process.cwd(), 'src/lib/automations/automation-handler.server.ts'), 'utf8')
		const failure = handler.slice(handler.indexOf('async function handleAutomationRunFailure'))
		expect(failure).toContain('const policy = automationTriggerPolicy(args.trigger)')
		expect(failure).toContain('if (!policy.escalateFailures)')
		expect(failure).toContain('payload: { automationId: args.automationId, attempt: nextAttempt, trigger: args.trigger }')
		expect(failure).toContain('advanceSchedule: !policy.preserveSchedule')
		expect(handler).toContain("trigger: z.enum(['schedule', 'manual', 'monitor'])")
	})
})
