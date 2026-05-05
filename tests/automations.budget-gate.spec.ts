import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #21 phase 5 — automation budget gate via the review inbox.
 *
 * Pins the contract that `runAutomationById` skips a run when an applicable budget cap is
 * exceeded, while:
 *   - opening exactly one `policy_override_request` review item per (limit, user, automation)
 *   - persisting a `block` budget_alert row
 *   - bumping lastRunAt + nextRunAt so the dispatcher doesn't keep re-attempting on the
 *     same minute tick
 *   - emitting an `automations.lifecycle.blocked` operational metric
 *
 * Each test seeds isolated automations + budget_limits + llm_usage rows under a unique prefix
 * so concurrent test runs don't collide. The "user" is always an existing active user (the
 * bootstrap admin in dev) since `automations.user_id` has a NOT NULL FK; the test only writes
 * scoped resources owned by that user and cleans them up in `finally`.
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

async function clearBudgets(userId: string) {
	const sql = getSql()
	await sql`delete from budget_alerts where user_id = ${userId}`
	await sql`delete from budget_limits where user_id = ${userId}`
}

async function clearUserUsage(userId: string) {
	const sql = getSql()
	await sql`delete from llm_usage where user_id = ${userId}`
	await sql`delete from tool_usage where user_id = ${userId}`
}

async function clearTestAutomations(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`%${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
}

async function settleMicrotasks() {
	// The metric + review-item writes use `void (async () => {...})()` for fire-and-forget. A
	// micro-yield is enough since the awaits inside resolve through the same event loop tick;
	// a slightly longer wait gives the dynamic import time to resolve on the first run.
	await new Promise((r) => setTimeout(r, 250))
}

test.describe('automations/budget-gate — pre-check skip', () => {
	test('runAutomationById blocks when an applicable global cap is exceeded', async () => {
		const prefix = uniquePrefix('automation-budget-block')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			await clearBudgets(userId)
			await clearUserUsage(userId)

			// Cap: $0.01 global / day, action=block. Burn $5 so any new run is over.
			await sql`
				insert into budget_limits (user_id, scope, period, limit_usd, warn_usd, action, enabled)
				values (${userId}, 'global', 'day', '0.01', null, 'block', true)
			`
			await sql`
				insert into llm_usage (user_id, source, model, tokens_in, tokens_out, cost)
				values (${userId}, 'chat', 'anthropic/claude-sonnet-4', 1000, 1000, '5.00')
			`

			// Schedule the automation in the past so the engine treats this tick as "now".
			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, next_run_at)
				values (${userId}, ${`${prefix} blocked`}, '0 9 * * *', ${`${prefix} prompt`}, ${past})
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = await runAutomationById(automation.id)
			expect((result as { blocked?: boolean }).blocked).toBe(true)
			expect((result as { conversationId: string | null }).conversationId).toBeNull()

			// No conversation/message side-effects when the run is skipped.
			const messageRows = await sql<{ count: number }[]>`
				select count(*)::int as count from messages where content like ${`${prefix}%`}
			`
			expect(messageRows[0].count).toBe(0)

			await settleMicrotasks()

			// Review item opened exactly once with the right dedupeKey + payload shape.
			const items = await sql<{
				type: string
				severity: string
				summary: string
				payload: { dedupeKey?: string; kind?: string; source?: string; automationId?: string }
			}[]>`
				select type::text as type, severity::text as severity, summary, payload
				from review_items
				where summary like ${`%${prefix}%`}
			`
			expect(items).toHaveLength(1)
			expect(items[0].type).toBe('policy_override_request')
			expect(items[0].severity).toBe('warning')
			expect(items[0].payload.kind).toBe('budget')
			expect(items[0].payload.source).toBe('automation')
			expect(items[0].payload.automationId).toBe(automation.id)
			expect(items[0].payload.dedupeKey).toMatch(/^budget:[\w-]+:[\w-]+:[\w-]+$/)

			// Schedule advanced + lastRunAt set so the next minute tick won't re-fire.
			const [updated] = await sql<{ last_run_at: Date | null; next_run_at: Date | null }[]>`
				select last_run_at, next_run_at from automations where id = ${automation.id}
			`
			expect(updated.last_run_at).not.toBeNull()
			expect(updated.next_run_at).not.toBeNull()
			expect(new Date(updated.next_run_at!).getTime()).toBeGreaterThan(past.getTime())

			// Block alert recorded.
			const alerts = await sql<{ trigger_type: string }[]>`
				select trigger_type::text as trigger_type
				from budget_alerts where user_id = ${userId}
			`
			expect(alerts.some((a) => a.trigger_type === 'block')).toBe(true)

			// Lifecycle metric emitted.
			const metrics = await sql<{ metric: string; dimension: { mode?: string; outputTarget?: string }; value: string }[]>`
				select metric, dimension, value::text as value
				from operational_metrics
				where metric = 'automations.lifecycle.blocked'
				order by measured_at desc
				limit 1
			`
			expect(metrics).toHaveLength(1)
			expect(metrics[0].dimension.mode).toBe('chat_followup')
			expect(metrics[0].dimension.outputTarget).toBe('chat_session')
		} finally {
			await clearBudgets(userId)
			await clearUserUsage(userId)
			await clearTestAutomations(prefix)
		}
	})

	test('repeated blocked runs dedupe to a single open review item', async () => {
		const prefix = uniquePrefix('automation-budget-dedupe')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			await clearBudgets(userId)
			await clearUserUsage(userId)

			await sql`
				insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
				values (${userId}, 'global', 'day', '0.01', 'block', true)
			`
			await sql`
				insert into llm_usage (user_id, source, model, tokens_in, tokens_out, cost)
				values (${userId}, 'chat', 'anthropic/claude-sonnet-4', 1000, 1000, '5.00')
			`

			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, next_run_at)
				values (${userId}, ${`${prefix} dedupe`}, '0 9 * * *', ${`${prefix} prompt`}, ${past})
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			await runAutomationById(automation.id)
			// Bump nextRunAt back into the past so the second call also "ticks" and re-attempts.
			await sql`update automations set next_run_at = ${past} where id = ${automation.id}`
			await runAutomationById(automation.id)

			await settleMicrotasks()

			const items = await sql<{ count: number }[]>`
				select count(*)::int as count
				from review_items
				where summary like ${`%${prefix}%`}
				  and status in ('open', 'in_progress')
			`
			expect(items[0].count).toBe(1)
		} finally {
			await clearBudgets(userId)
			await clearUserUsage(userId)
			await clearTestAutomations(prefix)
		}
	})
})

test.describe('automations/budget-gate — happy path passthrough', () => {
	test('runAutomationById does NOT short-circuit when no applicable cap blocks the run', async () => {
		// We only need to confirm the pre-check doesn't cause a regression for the unblocked
		// path; the run-success contract is covered elsewhere. Here we assert the function
		// proceeds past the budget gate (i.e. the fast-path "blocked: true" return is NOT
		// taken). Without an LLM key + agent the run will fail downstream — which proves the
		// block path is correctly NOT triggered by a cap that doesn't apply.
		const prefix = uniquePrefix('automation-budget-pass')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			await clearBudgets(userId)

			// Cap exists but is set far above any plausible spend — should never block.
			await sql`
				insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
				values (${userId}, 'global', 'day', '999999.99', 'block', true)
			`

			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, next_run_at)
				values (${userId}, ${`${prefix} ok`}, '0 9 * * *', ${`${prefix} prompt`}, ${past})
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			let blockedTaken = false
			try {
				const result = await runAutomationById(automation.id)
				blockedTaken = (result as { blocked?: boolean }).blocked === true
			} catch {
				// Downstream LLM/tool failure is fine — we only care that the gate passed.
				blockedTaken = false
			}
			expect(blockedTaken).toBe(false)
		} finally {
			await clearBudgets(userId)
			await clearTestAutomations(prefix)
			// Drop messages the synthesis path may have inserted before failing.
			await sql`delete from messages where content like ${`${prefix}%`}`
			await sql`delete from conversations where title like ${`${prefix}%`}`
		}
	})
})
