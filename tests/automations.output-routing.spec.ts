import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #21 phase 4 (output routing) — maintenance-mode result destinations.
 *
 * Each `outputTarget` enum value routes the maintenance summary to a different sink. We
 * exercise each target's persistence shape end-to-end against the live DB. Maintenance
 * mode dispatches a real LLM call (no mock layer); these tests ride on whatever the model
 * returns and only assert the persistence side, not the content.
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

async function clearTestAutomations(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`%${prefix}%`}`
	await sql`delete from artifact_versions where artifact_id in (select id from artifacts where name like ${`%${prefix}%`})`
	await sql`delete from artifacts where name like ${`%${prefix}%`}`
	await sql`delete from tasks where title like ${`%${prefix}%`}`
	await sql`delete from messages where content like ${`%${prefix}%`}`
	await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
	await sql`delete from conversations where title like ${`${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
}

async function ensureNoBlockingBudget(userId: string) {
	// Defensive cleanup so a stray budget_limit from another test (e.g. budget-gate
	// running earlier in the same Playwright worker) doesn't trip the maintenance run.
	const sql = getSql()
	await sql`delete from budget_alerts where user_id = ${userId}`
	await sql`delete from budget_limits where user_id = ${userId}`
	await sql`delete from llm_usage where user_id = ${userId} and cost::numeric > 1`
}

test.describe('automations/output-routing — review_inbox target', () => {
	test('maintenance run with outputTarget=review_inbox opens an automation_summary review item', async () => {
		const prefix = uniquePrefix('automation-out-inbox')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)

		try {
			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, output_target, next_run_at)
				values (
					${userId},
					${`${prefix} maintenance inbox`},
					'0 9 * * *',
					${'Say hello in one word.'},
					'maintenance'::automation_mode,
					'review_inbox'::automation_output_target,
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as {
				routedTo?: string
				reviewItemId?: string | null
			}
			expect(result.routedTo).toBe('review_inbox')

			const items = await sql<{
				type: string
				severity: string
				summary: string
				payload: { kind?: string; automationId?: string; mode?: string }
			}[]>`
				select type::text as type, severity::text as severity, summary, payload
				from review_items
				where summary like ${`%${prefix}%`}
			`
			expect(items).toHaveLength(1)
			expect(items[0].type).toBe('automation_summary')
			expect(items[0].severity).toBe('info')
			expect(items[0].payload.kind).toBe('maintenance_summary')
			expect(items[0].payload.automationId).toBe(automation.id)
			expect(items[0].payload.mode).toBe('maintenance')
		} finally {
			await clearTestAutomations(prefix)
		}
	})
})

test.describe('automations/output-routing — task target', () => {
	test('maintenance run with outputTarget=task creates a pending task', async () => {
		const prefix = uniquePrefix('automation-out-task')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)

		try {
			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, output_target, next_run_at)
				values (
					${userId},
					${`${prefix} maintenance task`},
					'0 9 * * *',
					${'Say hello in one word.'},
					'maintenance'::automation_mode,
					'task'::automation_output_target,
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as { routedTo?: string; taskId?: string | null }
			expect(result.routedTo).toBe('task')
			expect(typeof result.taskId).toBe('string')

			const tasks = await sql<{
				title: string
				status: string
				metadata: { source?: string; automationId?: string }
				created_by: string | null
			}[]>`
				select title, status::text as status, metadata, created_by
				from tasks
				where id = ${result.taskId!}
			`
			expect(tasks).toHaveLength(1)
			expect(tasks[0].title).toContain(prefix)
			expect(tasks[0].status).toBe('pending')
			expect(tasks[0].metadata.source).toBe('automation_maintenance')
			expect(tasks[0].metadata.automationId).toBe(automation.id)
			expect(tasks[0].created_by).toBe(userId)
		} finally {
			await clearTestAutomations(prefix)
		}
	})
})

test.describe('automations/output-routing — chat_session default', () => {
	test('maintenance with default chat_session writes an assistant message into the conversation', async () => {
		const prefix = uniquePrefix('automation-out-chat')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)

		try {
			const past = new Date(Date.now() - 5 * 60_000)
			// outputTarget defaults to chat_session — don't set it explicitly so we exercise the default path.
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, next_run_at)
				values (
					${userId},
					${`${prefix} maintenance chat`},
					'0 9 * * *',
					${'Say hello in one word.'},
					'maintenance'::automation_mode,
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as {
				routedTo?: string
				conversationId?: string | null
			}
			expect(result.routedTo).toBe('chat_session')
			expect(typeof result.conversationId).toBe('string')

			const messages = await sql<{
				role: string
				metadata: { source?: string; automationId?: string }
			}[]>`
				select role, metadata
				from messages
				where conversation_id = ${result.conversationId!}
				order by created_at asc
			`
			// Should have exactly ONE assistant message (the maintenance summary). No
			// user-role "Maintenance run at …" header should be inserted (that distinguishes
			// chat_session-routed maintenance from chat_followup mode's two-message pattern).
			expect(messages).toHaveLength(1)
			expect(messages[0].role).toBe('assistant')
			expect(messages[0].metadata.source).toBe('automation_maintenance')
			expect(messages[0].metadata.automationId).toBe(automation.id)
		} finally {
			await clearTestAutomations(prefix)
		}
	})
})

test.describe('automations/output-routing — artifact target with no project bound', () => {
	test('artifact target with no bound project skips with a structured marker (does not throw)', async () => {
		const prefix = uniquePrefix('automation-out-artifact-noproj')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)

		try {
			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, output_target, next_run_at)
				values (
					${userId},
					${`${prefix} maintenance artifact`},
					'0 9 * * *',
					${'Say hello in one word.'},
					'maintenance'::automation_mode,
					'artifact'::automation_output_target,
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as { routedTo?: string }
			expect(result.routedTo).toBe('artifact_skipped')

			// No artifact created.
			const artifacts = await sql<{ count: number }[]>`
				select count(*)::int as count from artifacts where name like ${`%${prefix}%`}
			`
			expect(artifacts[0].count).toBe(0)
		} finally {
			await clearTestAutomations(prefix)
		}
	})
})
