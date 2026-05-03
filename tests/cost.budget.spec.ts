import { expect, test, type BrowserContext } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const BASE_URL = 'http://127.0.0.1:4173'

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

async function buildCookieHeader(context: BrowserContext) {
	const cookies = await context.cookies(BASE_URL)
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

test.describe('cost/budget — limits + alerts schema', () => {
	test('inserting a global block limit round-trips with all fields', async () => {
		const prefix = uniquePrefix('budget-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await clearBudgets(userId)
			await sql`
				insert into budget_limits (user_id, scope, period, limit_usd, warn_usd, action, enabled)
				values (${userId}, 'global', 'month', '50.00', '40.00', 'block', true)
			`
			const [row] = await sql<{
				scope: string
				scope_id: string | null
				period: string
				limit_usd: string
				warn_usd: string | null
				action: string
				enabled: boolean
			}[]>`
				select scope, scope_id, period, limit_usd, warn_usd, action, enabled
				from budget_limits where user_id = ${userId}
			`
			expect(row.scope).toBe('global')
			expect(row.scope_id).toBeNull()
			expect(row.period).toBe('month')
			expect(parseFloat(row.limit_usd)).toBe(50)
			expect(parseFloat(row.warn_usd!)).toBe(40)
			expect(row.action).toBe('block')
			expect(row.enabled).toBe(true)
		} finally {
			await clearBudgets(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('budget_scope rejects unknown values', async () => {
		const prefix = uniquePrefix('budget-enum')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into budget_limits (user_id, scope, period, limit_usd)
					values (${userId}, 'sentinel', 'month', '10')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await clearBudgets(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('budget_alerts cascades when its parent budget_limit is deleted', async () => {
		const prefix = uniquePrefix('budget-cascade')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await clearBudgets(userId)
			const [limit] = await sql<{ id: string }[]>`
				insert into budget_limits (user_id, scope, period, limit_usd, action)
				values (${userId}, 'global', 'day', '5', 'block')
				returning id
			`
			await sql`
				insert into budget_alerts (budget_limit_id, user_id, trigger_type, spend_at_trigger, limit_usd, period)
				values (${limit.id}, ${userId}, 'block', '6', '5', 'day')
			`
			await sql`delete from budget_limits where id = ${limit.id}`
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from budget_alerts where user_id = ${userId}
			`
			expect(count, 'alerts must cascade-delete with the limit').toBe(0)
		} finally {
			await clearBudgets(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a global block budget below current spend rejects a new chat stream with 402', async ({ context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('budget-block-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await clearBudgets(userId)
			await clearUserUsage(userId)

			// Seed enough llm_usage in the current day to push the user over a $0.01 cap.
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id)
				values ('chat', 'anthropic/claude-sonnet-4', 100, 50, '0.10', ${userId})
			`
			// Block limit at $0.01 → we're already at $0.10 → next chat MUST be blocked.
			await sql`
				insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
				values (${userId}, 'global', 'day', '0.01', 'block', true)
			`

			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`

			const cookie = await buildCookieHeader(context)
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: hello`,
					regenerate: false,
				}),
			})
			expect(response.status).toBe(402)
			const body = (await response.json()) as { error?: string; limitId?: string }
			expect(body.error).toBe('budget_exceeded')
			expect(body.limitId).toBeTruthy()

			// A block alert row should exist.
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from budget_alerts
				where user_id = ${userId} and trigger_type = 'block'
			`
			expect(count, 'a block alert row must be inserted').toBeGreaterThan(0)

			// No chat_run row should have been created (block fires BEFORE the run insert).
			const [{ runCount }] = await sql<{ runCount: number }[]>`
				select count(*)::int as "runCount" from chat_runs where conversation_id = ${conv.id}
			`
			expect(runCount, 'no chat_run row should be created when blocked').toBe(0)
		} finally {
			await clearBudgets(userId)
			await clearUserUsage(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a notify_only limit lets the chat through but writes a warn alert', async ({ context }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('budget-notify-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await clearBudgets(userId)
			await clearUserUsage(userId)
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id)
				values ('chat', 'anthropic/claude-sonnet-4', 100, 50, '0.10', ${userId})
			`
			await sql`
				insert into budget_limits (user_id, scope, period, limit_usd, warn_usd, action, enabled)
				values (${userId}, 'global', 'day', '1.00', '0.05', 'notify_only', true)
			`

			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
				returning id
			`
			const cookie = await buildCookieHeader(context)
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: respond with the single word "ok".`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			// Drain the stream so the run completes.
			const reader = response.body!.getReader()
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}

			const [{ warnCount }] = await sql<{ warnCount: number }[]>`
				select count(*)::int as "warnCount" from budget_alerts
				where user_id = ${userId} and trigger_type = 'warn'
			`
			expect(warnCount, 'a warn alert must be written').toBeGreaterThan(0)

			const [{ runCount }] = await sql<{ runCount: number }[]>`
				select count(*)::int as "runCount" from chat_runs where conversation_id = ${conv.id}
			`
			expect(runCount, 'the run must have been created (notify_only does not block)').toBeGreaterThan(0)
		} finally {
			await clearBudgets(userId)
			await clearUserUsage(userId)
			await cleanupPrefixedRecords(prefix)
		}
	})
})
