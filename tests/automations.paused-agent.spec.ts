import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, seedAgent, uniquePrefix } from './helpers'
import { runAutomationById } from '../src/lib/automations/engine'
import { findPausedAutomationAgent, pausedAgentSkipMessage } from '../src/lib/automations/paused-agent.server'
import { createMonitor } from '../src/lib/monitors/monitors.server'
import { dispatchMonitorAction } from '../src/lib/monitors/actions.server'

/**
 * #66 — a paused agent does no unattended work.
 *
 * Pausing an agent keeps it out of delegation, and — the owner's call on #66 — keeps
 * automations and monitors from running it. Direct chats are untouched. These pin the
 * unattended half, which is checked where each kind of run starts:
 *
 *   `runAutomationById`   every automation run, whether the schedule, "Run now" or a
 *                         monitor fired it;
 *   `fireConversation`    a monitor whose action starts a conversation with an agent.
 *
 * None of these reach a model: a skipped run stops before anything is spent, which is the
 * point, and is also why this runs with no model credentials.
 */

async function seedAutomation(userId: string, prefix: string, agentId: string | null, nextRunAt: Date) {
	const [row] = await getSql()<{ id: string }[]>`
		insert into automations (user_id, agent_id, description, cron_expression, prompt, enabled, next_run_at)
		values (${userId}, ${agentId}, ${`${prefix} automation`}, '0 9 * * *', ${`${prefix} prompt`}, true, ${nextRunAt})
		returning id
	`
	return row.id
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`%${prefix}%`}`
	await sql`delete from monitors where name like ${`${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
	await cleanupPrefixedRecords(prefix)
}

test.describe('automations/paused-agent — the gate', () => {
	test('only a paused agent is reported; no agent, idle and active all run', async () => {
		const prefix = uniquePrefix('paused-agent-find')
		await cleanup(prefix)
		try {
			const paused = await seedAgent(prefix, { name: `${prefix} Paused`, status: 'paused' })
			const idle = await seedAgent(prefix, { name: `${prefix} Idle`, status: 'idle' })
			const active = await seedAgent(prefix, { name: `${prefix} Active`, status: 'active' })

			expect(await findPausedAutomationAgent(paused.id)).toEqual({ id: paused.id, name: `${prefix} Paused` })
			expect(await findPausedAutomationAgent(idle.id)).toBeNull()
			expect(await findPausedAutomationAgent(active.id)).toBeNull()
			expect(await findPausedAutomationAgent(null)).toBeNull()
		} finally {
			await cleanup(prefix)
		}
	})

	test('a scheduled tick is skipped, recorded as blocked with the reason, and the schedule moves on', async () => {
		const prefix = uniquePrefix('paused-agent-schedule')
		await cleanup(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agent = await seedAgent(prefix, { name: `${prefix} Benched`, status: 'paused' })
			// The spec drives the tick itself, and `runAutomationById` does not look at nextRunAt.
			// A slot a week out keeps the dev server's dispatcher from running the same
			// automation behind the test's back, and lets the assertion below see the skipped
			// tick move it to the next 09:00.
			const notDue = new Date(Date.now() + 7 * 24 * 60 * 60_000)
			const automationId = await seedAutomation(userId, prefix, agent.id, notDue)

			const tickAt = new Date()
			const result = await runAutomationById(automationId, tickAt, { trigger: 'schedule' })
			expect(result).toMatchObject({ blocked: true, reason: 'agent_paused', conversationId: null })

			// Nothing ran: no conversation was opened and no message written.
			expect(await sql`select id from conversations where agent_id = ${agent.id}`).toHaveLength(0)
			expect(await sql`select id from messages where content like ${`%${prefix} prompt%`}`).toHaveLength(0)

			// The run history says why, as `blocked` — not a failure.
			const runs = await sql<{ status: string; trigger: string; error: string | null }[]>`
				select status, trigger, error from automation_runs where automation_id = ${automationId}
			`
			expect(runs).toHaveLength(1)
			expect(runs[0]).toMatchObject({ status: 'blocked', trigger: 'schedule', error: pausedAgentSkipMessage(`${prefix} Benched`) })

			// The schedule moved on, so the dispatcher does not pick the slot up again next
			// minute; "last run" did not, because it did not run; the failure streak is untouched.
			const [row] = await sql<{ next_run_at: Date; last_run_at: Date | null; consecutive_failures: number }[]>`
				select next_run_at, last_run_at, consecutive_failures from automations where id = ${automationId}
			`
			expect(row.next_run_at.getTime(), 'rescheduled from this tick').toBeGreaterThan(tickAt.getTime())
			expect(row.next_run_at.getTime(), 'to the next 09:00, not left on the seeded slot').toBeLessThan(notDue.getTime())
			expect(row.last_run_at).toBeNull()
			expect(row.consecutive_failures).toBe(0)
		} finally {
			await cleanup(prefix)
		}
	})

	test('"Run now" is skipped too, and leaves the schedule where it was', async () => {
		const prefix = uniquePrefix('paused-agent-manual')
		await cleanup(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agent = await seedAgent(prefix, { status: 'paused' })
			const next = new Date(Date.now() + 24 * 60 * 60_000)
			const automationId = await seedAutomation(userId, prefix, agent.id, next)

			const result = await runAutomationById(automationId, new Date(), { trigger: 'manual' })
			expect(result).toMatchObject({ blocked: true, reason: 'agent_paused' })

			const [row] = await sql<{ next_run_at: Date }[]>`select next_run_at from automations where id = ${automationId}`
			expect(row.next_run_at.getTime()).toBe(next.getTime())
			const runs = await sql<{ status: string; trigger: string }[]>`
				select status, trigger from automation_runs where automation_id = ${automationId}
			`
			expect(runs).toEqual([{ status: 'blocked', trigger: 'manual' }])
		} finally {
			await cleanup(prefix)
		}
	})

	test('a monitor that would start a conversation with a paused agent does not, and the owner hears about it', async () => {
		const prefix = uniquePrefix('paused-agent-monitor')
		await cleanup(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agent = await seedAgent(prefix, { status: 'paused' })
			// `changed` records a baseline on its first check, and the monitor is not due, so the
			// dev server's dispatcher cannot fire this one for real before cleanup.
			const monitor = await createMonitor({
				userId,
				name: `${prefix} watcher`,
				condition: { kind: 'tool_result', tool: 'list_projects', args: {}, compare: 'changed' },
				action: 'start_conversation',
				actionConfig: { prompt: `${prefix} look at this`, agentId: agent.id },
			})
			await sql`update monitors set next_check_at = now() + interval '1 day' where id = ${monitor.id}`
			const observation = { value: `${prefix} observed`, hash: 'h', observedAt: new Date().toISOString(), met: true }

			const result = await dispatchMonitorAction(monitor, observation)
			expect(result.ok).toBe(false)
			expect(String(result.detail.error)).toMatch(/is paused/)
			expect(await sql`select id from conversations where agent_id = ${agent.id}`).toHaveLength(0)
			// What the monitor saw is not lost: the failed action falls back to a review item.
			const items = await sql<{ summary: string }[]>`select summary from review_items where summary like ${`%${prefix}%`}`
			expect(items).toHaveLength(1)
			expect(items[0].summary).toContain('start_conversation action failed')
		} finally {
			await cleanup(prefix)
		}
	})
})
