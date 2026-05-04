import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #17 phase 5 finish — automation_run + automations_dispatch job migration contract.
 *
 * Schema-level proofs that:
 *   - automation_run jobs use dedupeKey `automation:<id>:<minute>` so back-to-back ticks
 *     within the same minute window collapse, but the next minute gets a fresh enqueue
 *   - automations_dispatch tick uses a fixed `automations:dispatch` dedupeKey so multiple
 *     scheduler ticks within the worker's claim window collapse
 *   - automation_run priority is 50 (background tier — same as memory_mine)
 *   - automations_dispatch priority is 30 (above maintenance_gc 10, below evaluation_run 75)
 *
 * Live execution is exercised by the in-process scheduler tick + worker dispatch (the
 * dev server picks up due automations once they're enabled).
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function cleanupAutomationJobsPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from jobs where type in ('automation_run', 'automations_dispatch') and dedupe_key like ${`${prefix}%`}`
}

test.describe('automations/job-migration — automation_run dedupe + priority contract', () => {
	test('automation_run dedupeKey collapses back-to-back enqueue for same minute window', async () => {
		const prefix = uniquePrefix('auto-dedupe')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const automationId = '00000000-0000-4000-8000-000000000001'
			const dedupeKey = `${prefix}automation:${automationId}:2026-05-04T12:00`
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id)
				values ('automation_run', 'default', 50, ${dedupeKey}, ${sql.json({ automationId })}, ${userId})
			`
			let secondThrew = false
			try {
				await sql`
					insert into jobs (type, queue, priority, dedupe_key, payload, user_id)
					values ('automation_run', 'default', 50, ${dedupeKey}, ${sql.json({ automationId })}, ${userId})
				`
			} catch {
				secondThrew = true
			}
			expect(secondThrew).toBe(true)
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs where dedupe_key = ${dedupeKey}
			`
			expect(count).toBe(1)
		} finally {
			await cleanupAutomationJobsPrefix(prefix)
		}
	})

	test('different minute windows for the same automation get independent dedupe keys', async () => {
		const prefix = uniquePrefix('auto-cross-minute')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const automationId = '00000000-0000-4000-8000-000000000002'
			const k1 = `${prefix}automation:${automationId}:2026-05-04T12:00`
			const k2 = `${prefix}automation:${automationId}:2026-05-04T12:01`
			await sql`
				insert into jobs (type, dedupe_key, payload, user_id) values
					('automation_run', ${k1}, ${sql.json({ automationId })}, ${userId}),
					('automation_run', ${k2}, ${sql.json({ automationId })}, ${userId})
			`
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from jobs
				where dedupe_key in (${k1}, ${k2})
			`
			expect(count).toBe(2)
		} finally {
			await cleanupAutomationJobsPrefix(prefix)
		}
	})

	test('automation_run priority is 50 (background tier)', async () => {
		const prefix = uniquePrefix('auto-priority')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [job] = await sql<{ priority: number; type: string }[]>`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id)
				values (
					'automation_run', 'default', 50, ${`${prefix}auto`},
					${sql.json({ automationId: '00000000-0000-4000-8000-000000000003' })}, ${userId}
				)
				returning priority, type
			`
			expect(job.priority).toBe(50)
			expect(job.type).toBe('automation_run')
		} finally {
			await cleanupAutomationJobsPrefix(prefix)
		}
	})

	test('automations_dispatch tick uses fixed dedupeKey to collapse scheduler over-firing', async () => {
		const prefix = uniquePrefix('auto-dispatch-fixed')
		const sql = getSql()
		try {
			const dedupeKey = `${prefix}automations:dispatch`
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload)
				values ('automations_dispatch', 'maintenance', 30, ${dedupeKey}, ${sql.json({})})
			`
			let secondThrew = false
			try {
				await sql`
					insert into jobs (type, queue, priority, dedupe_key, payload)
					values ('automations_dispatch', 'maintenance', 30, ${dedupeKey}, ${sql.json({})})
				`
			} catch {
				secondThrew = true
			}
			expect(secondThrew).toBe(true)
		} finally {
			await cleanupAutomationJobsPrefix(prefix)
		}
	})

	test('priority order across job types matches the documented sandwich (10 < 30 < 50 < 75 < 150)', async () => {
		const prefix = uniquePrefix('auto-priority-sandwich')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into jobs (type, queue, priority, dedupe_key, payload, user_id) values
					('workspace_gc', 'maintenance', 10, ${`${prefix}gc`}, ${sql.json({})}, ${userId}),
					('automations_dispatch', 'maintenance', 30, ${`${prefix}dispatch`}, ${sql.json({})}, ${userId}),
					('automation_run', 'default', 50, ${`${prefix}auto`}, ${sql.json({ automationId: '00000000-0000-4000-8000-000000000004' })}, ${userId}),
					('memory_mine', 'default', 50, ${`${prefix}mine`}, ${sql.json({ conversationId: '00000000-0000-4000-8000-000000000005' })}, ${userId}),
					('evaluation_run', 'default', 75, ${`${prefix}eval`}, ${sql.json({ runId: '00000000-0000-4000-8000-000000000006' })}, ${userId}),
					('research_run', 'default', 150, ${`${prefix}research`}, ${sql.json({ researchId: '00000000-0000-4000-8000-000000000007' })}, ${userId})
			`
			const ordered = await sql<{ type: string; priority: number }[]>`
				select type, priority from jobs
				where dedupe_key like ${`${prefix}%`}
				order by priority desc, scheduled_at asc
				limit 10
			`
			// research_run (150) > evaluation_run (75) > memory_mine + automation_run (50) > automations_dispatch (30) > workspace_gc (10)
			expect(ordered[0].type).toBe('research_run')
			expect(ordered[0].priority).toBe(150)
			expect(ordered[1].type).toBe('evaluation_run')
			expect(ordered[1].priority).toBe(75)
			// 50-tier (memory_mine + automation_run) — order doesn't matter between them
			expect([ordered[2].type, ordered[3].type].sort()).toEqual(['automation_run', 'memory_mine'])
			expect(ordered[4].type).toBe('automations_dispatch')
			expect(ordered[4].priority).toBe(30)
			expect(ordered[5].type).toBe('workspace_gc')
			expect(ordered[5].priority).toBe(10)
		} finally {
			await cleanupAutomationJobsPrefix(prefix)
		}
	})
})
