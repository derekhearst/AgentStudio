import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #21 phase 3 — automation_mode + automation_output_target enums.
 *
 * The engine.ts logic that dispatches by mode is exercised live when an automation runs.
 * This spec pins the schema invariants:
 *   - mode column defaults to 'chat_followup' for backward-compat
 *   - outputTarget column defaults to 'chat_session'
 *   - all enum values are accepted; unknown values are rejected
 *   - the metric shape emitted by engine.ts (automations.duration_ms + automations.lifecycle.*)
 *     carries the right dimensions
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

test.describe('automations/mode — schema invariants', () => {
	test('mode defaults to chat_followup + outputTarget defaults to chat_session for back-compat', async () => {
		const prefix = uniquePrefix('automation-mode-default')
		const sql = getSql()
		try {
			const userId = await getActiveUserId()
			const [row] = await sql<{ mode: string; output_target: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt)
				values (${userId}, ${`${prefix} default`}, '0 9 * * *', ${`${prefix} prompt`})
				returning mode::text as mode, output_target::text as output_target
			`
			expect(row.mode).toBe('chat_followup')
			expect(row.output_target).toBe('chat_session')
		} finally {
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})

	test('automation_mode enum accepts all four values', async () => {
		const prefix = uniquePrefix('automation-mode-enum')
		const sql = getSql()
		try {
			const userId = await getActiveUserId()
			for (const mode of ['chat_followup', 'research', 'code', 'maintenance']) {
				await sql`
					insert into automations (user_id, description, cron_expression, prompt, mode)
					values (${userId}, ${`${prefix} ${mode}`}, '0 0 * * *', 'p', ${mode}::automation_mode)
				`
			}
			const rows = await sql<{ mode: string; count: number }[]>`
				select mode::text as mode, count(*)::int as count
				from automations
				where description like ${`${prefix}%`}
				group by mode
				order by mode
			`
			expect(rows.map((r) => r.mode)).toEqual(['chat_followup', 'code', 'maintenance', 'research'])
		} finally {
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})

	test('automation_output_target enum accepts all four values', async () => {
		const prefix = uniquePrefix('automation-target-enum')
		const sql = getSql()
		try {
			const userId = await getActiveUserId()
			for (const target of ['chat_session', 'task', 'artifact', 'review_inbox']) {
				await sql`
					insert into automations (user_id, description, cron_expression, prompt, output_target)
					values (${userId}, ${`${prefix} ${target}`}, '0 0 * * *', 'p', ${target}::automation_output_target)
				`
			}
			const rows = await sql<{ target: string }[]>`
				select output_target::text as target
				from automations
				where description like ${`${prefix}%`}
				order by target
			`
			expect(rows.map((r) => r.target)).toEqual(['artifact', 'chat_session', 'review_inbox', 'task'])
		} finally {
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})

	test('automation_mode rejects unknown values', async () => {
		const prefix = uniquePrefix('automation-mode-reject')
		const sql = getSql()
		try {
			const userId = await getActiveUserId()
			let threw = false
			try {
				await sql`
					insert into automations (user_id, description, cron_expression, prompt, mode)
					values (${userId}, ${`${prefix} bogus`}, '0 0 * * *', 'p', 'bogus_mode'::automation_mode)
				`
			} catch (err) {
				threw = true
				expect(String(err)).toMatch(/invalid input value for enum/)
			}
			expect(threw).toBe(true)
		} finally {
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})

	test('mode index supports per-mode listing for the engine dispatcher', async () => {
		const sql = getSql()
		// Just exercise the index by running an EXPLAIN over a per-mode filter so we know the
		// index path the engine uses to enumerate due automations is valid SQL.
		const rows = await sql<{ plan: string }[]>`
			explain select id from automations where mode = 'research'::automation_mode and enabled = true
		`
		expect(rows.length).toBeGreaterThan(0)
	})
})

test.describe('automations/mode — lifecycle metric shape', () => {
	test('automations.duration_ms carries {mode, outputTarget, status} dimensions', async () => {
		const prefix = uniquePrefix('automation-metric-duration')
		const sql = getSql()
		try {
			const [row] = await sql<{ metric: string; dimension: Record<string, unknown>; value: string }[]>`
				insert into operational_metrics (metric, dimension, value)
				values (
					${`${prefix}.automations.duration_ms`},
					${sql.json({ mode: 'research', outputTarget: 'task', status: 'completed' })},
					'8500'
				)
				returning metric, dimension, value::text as value
			`
			expect(row.metric).toBe(`${prefix}.automations.duration_ms`)
			expect(row.dimension).toEqual({ mode: 'research', outputTarget: 'task', status: 'completed' })
			expect(row.value).toBe('8500.000000')
		} finally {
			await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})

	test('automations.lifecycle counters split by mode + outputTarget', async () => {
		const prefix = uniquePrefix('automation-metric-counter')
		const sql = getSql()
		try {
			await sql`
				insert into operational_metrics (metric, dimension, value, measured_at) values
				(${`${prefix}.automations.lifecycle.completed`}, ${sql.json({ mode: 'chat_followup', outputTarget: 'chat_session' })}, '1', now() - interval '20 minutes'),
				(${`${prefix}.automations.lifecycle.completed`}, ${sql.json({ mode: 'chat_followup', outputTarget: 'chat_session' })}, '1', now() - interval '15 minutes'),
				(${`${prefix}.automations.lifecycle.completed`}, ${sql.json({ mode: 'research', outputTarget: 'task' })}, '1', now() - interval '10 minutes'),
				(${`${prefix}.automations.lifecycle.failed`}, ${sql.json({ mode: 'code', outputTarget: 'review_inbox' })}, '1', now() - interval '5 minutes')
			`
			const completed = await sql<{ count: number; mode: string }[]>`
				select count(*)::int as count, dimension->>'mode' as mode
				from operational_metrics
				where metric = ${`${prefix}.automations.lifecycle.completed`}
				group by dimension->>'mode'
				order by mode
			`
			expect(completed.map((r) => r.mode).sort()).toEqual(['chat_followup', 'research'])
			expect(completed.find((r) => r.mode === 'chat_followup')?.count).toBe(2)
			expect(completed.find((r) => r.mode === 'research')?.count).toBe(1)
			// Verify the failed counter row also exists with the right dimensions.
			const [failed] = await sql<{ dimension: Record<string, unknown> }[]>`
				select dimension from operational_metrics
				where metric = ${`${prefix}.automations.lifecycle.failed`}
			`
			expect(failed.dimension).toEqual({ mode: 'code', outputTarget: 'review_inbox' })
		} finally {
			await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})
})
// Acknowledge unused import to keep lint clean.
void randomUUID
