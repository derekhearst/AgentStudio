import { expect, test } from '@playwright/test'
import {
	acquireGlobalStateLock,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedAgent,
	seedConversation,
	uniquePrefix,
} from './helpers'

/**
 * #38 — the usage digest's queries against a real database, and the weekly digest
 * automation end to end.
 *
 * The ledgers are read instance-wide, so a window over "now" would mix these fixtures with
 * whatever else the database holds. The aggregate test therefore puts its rows in a week in
 * January 2001 that nothing else writes to, and asks for the digest as of the end of that
 * week: every total is then exactly the fixtures. Budget enforcement counts from the start
 * of the current period, so rows that far back cannot move a live limit.
 *
 * Serialized with the other specs that write this user's ledger and budget limits (see
 * `acquireGlobalStateLock`). Nothing here clears rows it did not create.
 *
 * No model is called anywhere in this file, which is part of what it pins: the digest
 * automation must complete with no model credential at all (run it with
 * E2E_NO_MODEL_CREDENTIALS=1 to see that).
 */

let releaseBudgetLock: (() => Promise<void>) | null = null
test.beforeEach(async () => {
	releaseBudgetLock = await acquireGlobalStateLock('budget-state')
})
test.afterEach(async () => {
	await releaseBudgetLock?.()
	releaseBudgetLock = null
})

const WINDOW_END = new Date('2001-01-08T00:00:00.000Z')
const IN_WINDOW = new Date('2001-01-05T12:00:00.000Z')
const PREVIOUS_WINDOW = new Date('2000-12-29T12:00:00.000Z')
const AFTER_WINDOW = new Date('2001-01-10T12:00:00.000Z')

async function cleanupLedger(prefix: string) {
	const sql = getSql()
	await sql`delete from llm_usage where model like ${`${prefix}%`}`
	await sql`delete from tool_usage where tool_name like ${`${prefix}%`}`
	await sql`delete from monitors where name like ${`${prefix}%`}`
	await sql`delete from review_items where summary like ${`%${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
	await cleanupPrefixedRecords(prefix)
}

test.describe('costs/usage-digest live — aggregation', () => {
	test('a fixture week adds up exactly, and its anomalies come out', async () => {
		const prefix = uniquePrefix('usage-digest')
		const sql = getSql()
		const userId = await getActiveUserId()
		const model = `${prefix}-model`

		try {
			const agent = await seedAgent(prefix)
			const conversation = await seedConversation(prefix, { userId })

			// Model usage: two rows this week (one a subscription turn), one the week before.
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, tokens_cache_read, cost, user_id, agent_id, metadata, created_at)
				values
					('chat', ${model}, 1000, 100, 5000, '0.5', ${userId}, ${agent.id}, '{"subscription": true}'::jsonb, ${IN_WINDOW}),
					('chat', ${model}, 2000, 200, 0, '0.25', ${userId}, ${agent.id}, '{}'::jsonb, ${IN_WINDOW}),
					('chat', ${model}, 10, 0, 0, '0.1', ${userId}, null, '{}'::jsonb, ${PREVIOUS_WINDOW})
			`

			// Tool calls: three Reads (one failed), and one paid call that writes a credit row
			// alongside its call row — two rows, one call.
			await sql`
				insert into tool_usage (tool_name, unit_type, units, cost, user_id, metadata, created_at)
				values
					(${`${prefix}-Read`}, 'call', '1', '0', ${userId}, '{"success": true}'::jsonb, ${IN_WINDOW}),
					(${`${prefix}-Read`}, 'call', '1', '0', ${userId}, '{"success": true}'::jsonb, ${IN_WINDOW}),
					(${`${prefix}-Read`}, 'call', '1', '0', ${userId}, '{"success": false}'::jsonb, ${IN_WINDOW}),
					(${`${prefix}-image`}, 'call', '1', '0', ${userId}, '{"success": true}'::jsonb, ${IN_WINDOW}),
					(${`${prefix}-image`}, 'credit', '4', '0.2', ${userId}, '{}'::jsonb, ${IN_WINDOW})
			`

			// Chat runs: 3 completed, 1 failed, 1 canceled → a 25% failure rate.
			await sql`
				insert into chat_runs (conversation_id, user_id, state, created_at)
				values
					(${conversation.id}, ${userId}, 'completed', ${IN_WINDOW}),
					(${conversation.id}, ${userId}, 'completed', ${IN_WINDOW}),
					(${conversation.id}, ${userId}, 'completed', ${IN_WINDOW}),
					(${conversation.id}, ${userId}, 'failed', ${IN_WINDOW}),
					(${conversation.id}, ${userId}, 'canceled', ${IN_WINDOW})
			`

			// An automation that started failing this week and got switched off for it.
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, enabled, disabled_reason, updated_at)
				values (${userId}, ${`${prefix} nightly`}, '0 9 * * *', ${`${prefix} prompt`}, 'maintenance', false, 'consecutive_failures', ${IN_WINDOW})
				returning id
			`
			await sql`
				insert into automation_runs (automation_id, user_id, status, mode, started_at, cost_usd)
				values
					(${automation.id}, ${userId}, 'completed', 'maintenance', ${IN_WINDOW}, '0.05'),
					(${automation.id}, ${userId}, 'failed', 'maintenance', ${IN_WINDOW}, null),
					(${automation.id}, ${userId}, 'failed', 'maintenance', ${IN_WINDOW}, null),
					(${automation.id}, ${userId}, 'completed', 'maintenance', ${PREVIOUS_WINDOW}, '0')
			`
			// One that failed this week but was only switched off after the window ended: as of
			// the window's end it is newly failing, not yet switched off.
			const [laterDisabled] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, enabled, disabled_reason, updated_at)
				values (${userId}, ${`${prefix} weekly`}, '0 9 * * 1', ${`${prefix} prompt`}, 'maintenance', false, 'consecutive_failures', ${AFTER_WINDOW})
				returning id
			`
			await sql`
				insert into automation_runs (automation_id, user_id, status, mode, started_at, cost_usd)
				values (${laterDisabled.id}, ${userId}, 'failed', 'maintenance', ${IN_WINDOW}, null)
			`

			// A monitor that ran out of time without ever firing, and one that fired.
			await sql`
				insert into monitors (user_id, name, status, condition_kind, condition, action, deadline_at, fire_count, updated_at)
				values
					(${userId}, ${`${prefix} release watch`}, 'expired', 'tool_result', '{}'::jsonb, 'review_item', ${IN_WINDOW}, 0, ${IN_WINDOW}),
					(${userId}, ${`${prefix} fired watch`}, 'expired', 'tool_result', '{}'::jsonb, 'review_item', ${IN_WINDOW}, 2, ${IN_WINDOW})
			`

			const { computeUsageDigest } = await import('../src/lib/costs/usage-digest.server')
			const { renderDigestMarkdown } = await import('../src/lib/costs/usage-digest')
			const digest = await computeUsageDigest({ userId, days: 7, now: WINDOW_END })

			expect(digest.since).toBe('2001-01-01T00:00:00.000Z')
			expect(digest.tokens).toEqual({
				in: 3000,
				out: 300,
				cacheRead: 5000,
				cacheWrite: 0,
				total: 3300,
				previousTotal: 10,
			})
			expect(digest.metered.llmUsd).toBeCloseTo(0.75)
			expect(digest.metered.toolUsd).toBeCloseTo(0.2)
			expect(digest.metered.previousUsd).toBeCloseTo(0.1)
			expect(digest.llmCalls).toBe(2)
			expect(digest.hasSubscriptionUsage).toBe(true)

			expect(digest.models).toEqual([
				expect.objectContaining({ model, tokensIn: 3000, tokensOut: 300, tokensCacheRead: 5000, calls: 2, subscription: true }),
			])
			expect(digest.agents).toEqual([
				expect.objectContaining({ agentId: agent.id, name: agent.name, tokensIn: 3000, tokensOut: 300, calls: 2 }),
			])

			// The credit row carries the spend but is not a second call.
			expect(digest.tools.calls).toBe(4)
			expect(digest.tools.failed).toBe(1)
			expect(digest.tools.top).toEqual([
				expect.objectContaining({ toolName: `${prefix}-Read`, calls: 3, failed: 1 }),
				expect.objectContaining({ toolName: `${prefix}-image`, calls: 1, failed: 0 }),
			])
			expect(digest.tools.top[1].costUsd).toBeCloseTo(0.2)

			expect(digest.runs).toEqual({ total: 5, completed: 3, failed: 1, canceled: 1, inFlight: 0, failureRate: 0.25 })

			expect(digest.automations).toMatchObject({ runs: 4, completed: 1, failed: 3 })
			expect(digest.automations.items).toEqual([
				expect.objectContaining({ automationId: automation.id, runs: 3, failed: 2, prevFailed: 0, disabledInWindow: true }),
				expect.objectContaining({ automationId: laterDisabled.id, runs: 1, failed: 1, prevFailed: 0, disabledInWindow: false }),
			])
			expect(digest.automations.costUsd).toBeCloseTo(0.05)

			const anomalies = digest.anomalies.map((a) => [a.kind, a.message])
			expect(anomalies).toContainEqual(['automation_disabled', `Automation “${prefix} nightly” has been switched off after failing repeatedly.`])
			expect(anomalies).toContainEqual([
				'automation_newly_failing',
				`Automation “${prefix} weekly” failed once, after no failures the previous 7 days.`,
			])
			expect(anomalies.filter(([kind]) => kind === 'automation_disabled')).toHaveLength(1)
			expect(anomalies).toContainEqual(['run_failure_rate', '25% of finished runs failed (1 of 4).'])
			expect(anomalies).toContainEqual([
				'monitor_never_fired',
				`Monitor “${prefix} release watch” reached its deadline without ever firing.`,
			])
			expect(anomalies.map(([kind]) => kind)).not.toContain('spend_spike') // $0.95 is under the floor
			expect(anomalies.some(([, message]) => message.includes('fired watch'))).toBe(false)

			const markdown = renderDigestMarkdown(digest)
			expect(markdown).toContain('## Usage digest: last 7 days')
			expect(markdown).toContain('- **Tool calls:** 4 (1 failed)')
		} finally {
			await cleanupLedger(prefix)
		}
	})

	test('budget headroom reads enabled standing limits the way enforcement does', async () => {
		const prefix = uniquePrefix('usage-digest-budget')
		const sql = getSql()
		const userId = await getActiveUserId()
		const created: string[] = []

		try {
			// A limit nothing could reach, so this spec cannot block anything while it runs.
			const [standing] = await sql<{ id: string }[]>`
				insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
				values (${userId}, 'global', 'month', '1000000', 'notify_only', true)
				returning id
			`
			const [disabled] = await sql<{ id: string }[]>`
				insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
				values (${userId}, 'global', 'month', '1000000', 'notify_only', false)
				returning id
			`
			const [perRun] = await sql<{ id: string }[]>`
				insert into budget_limits (user_id, scope, period, limit_usd, action, enabled)
				values (${userId}, 'global', 'run', '1000000', 'notify_only', true)
				returning id
			`
			created.push(standing.id, disabled.id, perRun.id)
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id)
				values ('chat', ${`${prefix}-model`}, 1, 1, '0.01', ${userId})
			`

			const { listBudgetHeadroom } = await import('../src/lib/costs/budget.server')
			const headroom = await listBudgetHeadroom(userId)
			const ids = headroom.map((limit) => limit.id)

			expect(ids).toContain(standing.id)
			expect(ids, 'a disabled limit is not headroom').not.toContain(disabled.id)
			expect(ids, 'a per-run limit has no standing period').not.toContain(perRun.id)

			const row = headroom.find((limit) => limit.id === standing.id)!
			expect(row).toMatchObject({ scope: 'global', period: 'month', limitUsd: 1_000_000, action: 'notify_only' })
			expect(row.spendUsd).toBeGreaterThanOrEqual(0.01)
			expect(row.pct).toBeCloseTo(row.spendUsd / 1_000_000)
			// Tightest first.
			expect(headroom.map((limit) => limit.pct)).toEqual([...headroom.map((limit) => limit.pct)].sort((a, b) => b - a))
		} finally {
			for (const id of created) await sql`delete from budget_limits where id = ${id}`
			await sql`delete from llm_usage where model = ${`${prefix}-model`}`
		}
	})
})

test.describe('costs/usage-digest live — the weekly digest automation', () => {
	test('a {{usage_digest}} maintenance run lands in the review inbox without calling a model', async () => {
		const prefix = uniquePrefix('usage-digest-inbox')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, output_target)
				values (${userId}, ${`${prefix} digest`}, '0 9 * * 1', '{{usage_digest}}', 'maintenance', 'review_inbox')
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as {
				routedTo?: string
				costUsd?: string | null
				reviewItemId?: string | null
			}
			expect(result.routedTo).toBe('review_inbox')
			expect(result.costUsd).toBe('0')

			const [item] = await sql<{ id: string; type: string; payload: { summary?: string; kind?: string } }[]>`
				select id, type, payload from review_items where id = ${result.reviewItemId!}
			`
			expect(item.type).toBe('automation_summary')
			expect(item.payload.kind).toBe('maintenance_summary')
			expect(item.payload.summary).toMatch(/^## Usage digest: last 7 days\n/)
			expect(item.payload.summary).toContain('### Numbers')

			// The ledger saw the run, at no cost, and no model call was logged for it.
			const [run] = await sql<{ status: string; cost_usd: string | null }[]>`
				select status, cost_usd from automation_runs where automation_id = ${automation.id}
			`
			expect(run.status).toBe('completed')
			expect(Number(run.cost_usd)).toBe(0)
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from llm_usage where metadata->>'automationId' = ${automation.id}
			`
			expect(count).toBe(0)
		} finally {
			await cleanupLedger(prefix)
		}
	})

	test('the chat target posts the digest as an assistant message in the automation thread', async () => {
		const prefix = uniquePrefix('usage-digest-chat')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, output_target, conversation_mode)
				values (${userId}, ${`${prefix} digest`}, '0 9 * * 1', '{{usage_digest:1}}', 'maintenance', 'chat_session', 'reuse')
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as { routedTo?: string; conversationId?: string | null }
			expect(result.routedTo).toBe('chat_session')

			const messages = await sql<{ role: string; content: string; model: string | null }[]>`
				select role, content, model from messages where conversation_id = ${result.conversationId!}
			`
			expect(messages).toHaveLength(1)
			expect(messages[0].role).toBe('assistant')
			expect(messages[0].content).toMatch(/^## Usage digest: last 24 hours\n/)
			// Written by code, not a model.
			expect(messages[0].model).toBeNull()
		} finally {
			await cleanupLedger(prefix)
		}
	})

	test('opting in creates one digest automation, and opting in again re-targets it', async () => {
		const sql = getSql()
		const userId = await getActiveUserId()
		const { findUsageDigestAutomation, enableUsageDigestAutomation } = await import(
			'../src/lib/automations/usage-digest-automation.server'
		)
		// The owner's own digest, if they have one, is theirs: do not touch it.
		test.skip((await findUsageDigestAutomation(userId)) !== null, 'this instance already has a usage digest automation')

		let createdId: string | null = null
		try {
			const first = await enableUsageDigestAutomation(userId, { outputTarget: 'review_inbox', timezone: 'Europe/Berlin' })
			createdId = first.id
			expect(first).toMatchObject({
				enabled: true,
				outputTarget: 'review_inbox',
				cronExpression: '0 9 * * 1',
				timezone: 'Europe/Berlin',
				days: 7,
			})

			const second = await enableUsageDigestAutomation(userId, { outputTarget: 'chat_session' })
			expect(second.id).toBe(first.id)
			expect(second.outputTarget).toBe('chat_session')

			const [row] = await sql<{ prompt: string; mode: string; conversation_mode: string }[]>`
				select prompt, mode, conversation_mode from automations where id = ${first.id}
			`
			expect(row).toEqual({ prompt: '{{usage_digest}}', mode: 'maintenance', conversation_mode: 'reuse' })
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from automations
				where user_id = ${userId} and mode = 'maintenance' and prompt = '{{usage_digest}}'
			`
			expect(count).toBe(1)
		} finally {
			if (createdId) await sql`delete from automations where id = ${createdId}`
		}
	})
})
