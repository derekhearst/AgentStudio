import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * The daily and monthly limits in Settings → Budget are enforced, and they alert.
 *
 * They were stored in `app_settings.budget_config` and read only by the progress bars on
 * /review. The budget gate reads `budget_limits`, which no page writes, so a $5 daily limit
 * blocked nothing, recorded no alert and notified no one. Each Settings limit is now a
 * global block row the gate checks, warning at 80%.
 *
 * Budget limits, the usage ledger and settings all belong to the instance's one user, so
 * these hold the same `budget-state` lock as the other budget specs (and `settings-state`,
 * taken second, for the settings row), and restore what they change. They never wipe the
 * user's ledger: each limit is set relative to what has already been spent today.
 */

type BudgetConfig = { dailyLimit: number | null; monthlyLimit: number | null; limitIds?: Record<string, string | null> }

let releases: Array<() => Promise<void>> = []
let originalConfig: BudgetConfig | null = null
let startedAt = new Date()

test.beforeEach(async () => {
	releases = [await acquireGlobalStateLock('budget-state'), await acquireGlobalStateLock('settings-state')]
	const { getOrCreateSettings } = await import('../src/lib/settings/settings.server')
	originalConfig = (await getOrCreateSettings(await getActiveUserId())).budgetConfig as BudgetConfig
	// The database's clock, not this machine's: rows are stamped by the server, which may run
	// a few seconds behind.
	const [{ now }] = await getSql()<{ now: Date }[]>`select now() as now`
	startedAt = now
})

test.afterEach(async () => {
	const sql = getSql()
	const userId = await getActiveUserId()
	// Remove the rows these tests made Settings create, then put the settings back.
	const [row] = await sql<{ budget_config: BudgetConfig }[]>`
		select budget_config from app_settings where user_id = ${userId} order by created_at asc limit 1
	`
	const created = Object.values(row?.budget_config?.limitIds ?? {}).filter(
		(id): id is string => typeof id === 'string' && !Object.values(originalConfig?.limitIds ?? {}).includes(id),
	)
	if (created.length) await sql`delete from budget_limits where id in ${sql(created)}`
	if (originalConfig) {
		await sql`update app_settings set budget_config = ${sql.json(originalConfig)} where user_id = ${userId}`
	}
	await sql`
		delete from notifications
		where user_id = ${userId} and title in ('Budget limit reached', 'Budget nearly used') and created_at >= ${startedAt}
	`
	for (const release of releases.reverse()) await release()
	releases = []
})

/** What the gate counts for the user today: model and tool spend since local midnight. */
async function spendToday(userId: string): Promise<number> {
	const sql = getSql()
	const now = new Date()
	const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
	const [{ total }] = await sql<{ total: string }[]>`
		select (
			(select coalesce(sum(cost), 0) from llm_usage where user_id = ${userId} and created_at >= ${dayStart}) +
			(select coalesce(sum(cost), 0) from tool_usage where user_id = ${userId} and created_at >= ${dayStart})
		)::text as total
	`
	return parseFloat(total)
}

async function readLimit(id: string) {
	const sql = getSql()
	const [row] = await sql<{
		scope: string
		scope_id: string | null
		period: string
		limit_usd: string
		warn_usd: string | null
		action: string
		enabled: boolean
	}[]>`select scope::text as scope, scope_id, period::text as period, limit_usd, warn_usd, action::text as action, enabled from budget_limits where id = ${id}`
	return row
}

async function settingsLimitIds(userId: string) {
	const sql = getSql()
	const [row] = await sql<{ budget_config: BudgetConfig }[]>`
		select budget_config from app_settings where user_id = ${userId} order by created_at asc limit 1
	`
	return row.budget_config.limitIds ?? {}
}

test.describe('costs/settings-budget — Settings limits are enforced', () => {
	test('saving a daily limit creates a global block limit that warns at 80%', async () => {
		const userId = await getActiveUserId()
		const { updateSettings } = await import('../src/lib/settings/settings.server')

		const saved = await updateSettings({ userId, budgetConfig: { dailyLimit: 5, monthlyLimit: null } })

		const ids = await settingsLimitIds(userId)
		expect(ids.day).toBeTruthy()
		expect((saved.budgetConfig as BudgetConfig).limitIds?.day).toBe(ids.day)
		const limit = await readLimit(ids.day!)
		expect(limit).toMatchObject({ scope: 'global', scope_id: null, period: 'day', action: 'block', enabled: true })
		expect(parseFloat(limit.limit_usd)).toBe(5)
		expect(parseFloat(limit.warn_usd!)).toBe(4)
		expect(ids.month ?? null, 'no monthly limit was set, so no monthly row').toBeNull()
	})

	test('a chat past the Settings limit is blocked, the alert records the real spend, and the user is told', async () => {
		const prefix = uniquePrefix('settings-budget-block')
		const sql = getSql()
		const userId = await getActiveUserId()
		try {
			const before = await spendToday(userId)
			const { updateSettings } = await import('../src/lib/settings/settings.server')
			await updateSettings({ userId, budgetConfig: { dailyLimit: before + 10 } })
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id, metadata)
				values ('chat', 'claude-sonnet-5', 1, 1, '12.5', ${userId}, ${sql.json({ spec: prefix })})
			`

			const { enforceBudgetGuard } = await import('../src/lib/chat/stream-prep.server')
			const verdict = await enforceBudgetGuard({ userId, agentId: null, conversationId: '00000000-0000-0000-0000-000000000000' })
			expect(verdict.blocked).toBe(true)

			const ids = await settingsLimitIds(userId)
			const [alert] = await sql<{ spend_at_trigger: string; limit_usd: string }[]>`
				select spend_at_trigger::text, limit_usd::text from budget_alerts
				where budget_limit_id = ${ids.day!} and trigger_type = 'block'
			`
			// The overshoot is the point of the record: spend, not the limit it crossed.
			expect(parseFloat(alert.spend_at_trigger)).toBeCloseTo(before + 12.5, 4)
			expect(parseFloat(alert.limit_usd)).toBeCloseTo(before + 10, 4)

			await expect
				.poll(async () => {
					const rows = await sql<{ count: number }[]>`
						select count(*)::int as count from notifications
						where user_id = ${userId} and title = 'Budget limit reached' and created_at >= ${startedAt}
					`
					return rows[0].count
				})
				.toBe(1)
		} finally {
			await sql`delete from llm_usage where metadata->>'spec' = ${prefix}`
			await sql`delete from review_items where payload->>'conversationId' = '00000000-0000-0000-0000-000000000000'`
		}
	})

	test('clearing the limit switches its row off and keeps its alert history', async () => {
		const userId = await getActiveUserId()
		const { updateSettings } = await import('../src/lib/settings/settings.server')
		await updateSettings({ userId, budgetConfig: { dailyLimit: 3 } })
		const dayId = (await settingsLimitIds(userId)).day!

		await updateSettings({ userId, budgetConfig: { dailyLimit: null } })

		const limit = await readLimit(dayId)
		expect(limit, 'the row is kept, so alerts pointing at it survive').toBeTruthy()
		expect(limit.enabled).toBe(false)
	})

	test('a limit saved before this existed is enforced from the next check', async () => {
		const sql = getSql()
		const userId = await getActiveUserId()
		// What a row saved through the old Settings page looks like: limits, no row ids.
		await sql`
			update app_settings set budget_config = ${sql.json({ dailyLimit: null, monthlyLimit: 250 })}
			where user_id = ${userId}
		`
		const { checkBudgetLimits } = await import('../src/lib/costs/budget.server')
		await checkBudgetLimits({ userId })

		const monthId = (await settingsLimitIds(userId)).month
		expect(monthId).toBeTruthy()
		const limit = await readLimit(monthId!)
		expect(limit).toMatchObject({ scope: 'global', period: 'month', action: 'block', enabled: true })
		expect(parseFloat(limit.limit_usd)).toBe(250)
	})

	test('a limit created some other way is never touched by Settings', async () => {
		const sql = getSql()
		const userId = await getActiveUserId()
		const [other] = await sql<{ id: string }[]>`
			insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
			values (${userId}, 'global', 'day', '1234', 'notify_only', true)
			returning id
		`
		try {
			const { updateSettings } = await import('../src/lib/settings/settings.server')
			await updateSettings({ userId, budgetConfig: { dailyLimit: null, monthlyLimit: null } })
			const { checkBudgetLimits } = await import('../src/lib/costs/budget.server')
			await checkBudgetLimits({ userId })

			const limit = await readLimit(other.id)
			expect(limit.enabled).toBe(true)
			expect(parseFloat(limit.limit_usd)).toBe(1234)
			expect(limit.action).toBe('notify_only')
		} finally {
			await sql`delete from budget_limits where id = ${other.id}`
		}
	})
})
