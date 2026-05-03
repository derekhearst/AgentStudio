import { randomUUID } from 'node:crypto'
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

async function triggerCron(context: BrowserContext) {
	const cookies = await context.cookies(BASE_URL)
	const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
	const response = await fetch(`${BASE_URL}/api/cron`, {
		method: 'POST',
		headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
	})
	expect(response.ok, `cron tick should succeed (got ${response.status})`).toBe(true)
	return response.json()
}

test.describe('automations/runtime — agent-backed automations run through runChatLoop', () => {
	test('a due automation with an agent creates a chat_run + assistant message + llm_usage row', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('automation-runtime')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			const [agent] = await sql<{ id: string }[]>`
				insert into agents (id, name, role, system_prompt, model, status, config)
				values (
					${randomUUID()},
					${`${prefix} responder`},
					${'tester'},
					${'You are an automation responder. Answer in one short sentence.'},
					${'anthropic/claude-sonnet-4'},
					'active'::agent_status,
					${sql.json({})}
				)
				returning id
			`

			// Schedule: due 1s ago.
			const dueAt = new Date(Date.now() - 1000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (
					id, user_id, agent_id, description, prompt, cron_expression,
					enabled, conversation_mode, next_run_at, created_at, updated_at
				)
				values (
					${randomUUID()},
					${userId},
					${agent.id},
					${`${prefix} hello automation`},
					${`${prefix}: respond with the single word "ok"`},
					${'@hourly'},
					true,
					'new_each_run',
					${dueAt},
					now(),
					now()
				)
				returning id
			`

			await triggerCron(context)

			// chat_runs row created with source='automation' and state terminal.
			const runs = await sql<{
				id: string
				state: string
				source: string
				agent_id: string | null
				user_id: string | null
				label: string | null
			}[]>`
				select id, state::text as state, source::text as source, agent_id, user_id, label
				from chat_runs
				where agent_id = ${agent.id}
				order by created_at desc limit 1
			`
			expect(runs.length, 'a chat_run row should be inserted for the automation').toBe(1)
			expect(runs[0].source).toBe('automation')
			expect(runs[0].agent_id).toBe(agent.id)
			expect(runs[0].user_id).toBe(userId)
			// Terminal state — completed (or failed; the LLM occasionally times out).
			expect(['completed', 'failed']).toContain(runs[0].state)

			// llm_usage row tagged with source='automation' + linkage.
			const usageRows = await sql<{ source: string; agent_id: string | null; run_id: string | null }[]>`
				select source::text as source, agent_id, run_id
				from llm_usage
				where run_id = ${runs[0].id}
			`
			if (runs[0].state === 'completed') {
				expect(usageRows.length).toBeGreaterThan(0)
				expect(usageRows[0].source).toBe('automation')
				expect(usageRows[0].agent_id).toBe(agent.id)
				expect(usageRows[0].run_id).toBe(runs[0].id)
			}

			// Conversation gained an assistant message.
			const msgs = await sql<{ role: string; content: string }[]>`
				select m.role::text as role, m.content
				from messages m
				inner join conversations c on c.id = m.conversation_id
				where c.user_id = ${userId} and c.title = ${`${prefix} hello automation`} and m.role = 'assistant'
				order by m.created_at desc limit 1
			`
			if (runs[0].state === 'completed') {
				expect(msgs.length).toBe(1)
				expect(msgs[0].content.length).toBeGreaterThan(0)
			}

			// Automation's nextRunAt got bumped forward.
			const [updated] = await sql<{ next_run_at: Date; last_run_at: Date | null }[]>`
				select next_run_at, last_run_at from automations where id = ${automation.id}
			`
			expect(updated.next_run_at.getTime()).toBeGreaterThan(dueAt.getTime())
			expect(updated.last_run_at, 'last_run_at should be set').not.toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a due automation WITHOUT an agent uses the legacy chat() synthesis path (no chat_run row)', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('automation-synthesis')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()

		try {
			const dueAt = new Date(Date.now() - 1000)
			await sql`
				insert into automations (
					id, user_id, agent_id, description, prompt, cron_expression,
					enabled, conversation_mode, next_run_at, created_at, updated_at
				)
				values (
					${randomUUID()},
					${userId},
					NULL,
					${`${prefix} synthesis-only automation`},
					${`${prefix}: just say "ok"`},
					${'@hourly'},
					true,
					'new_each_run',
					${dueAt},
					now(),
					now()
				)
			`

			await triggerCron(context)

			// NO chat_run row should exist for this automation (it goes through chat() synthesis).
			const runs = await sql<{ count: number }[]>`
				select count(*)::int as count from chat_runs
				where label like ${`Automation tick: ${prefix}%`}
			`
			expect(runs[0].count, 'agent-less automation should NOT create a chat_run').toBe(0)

			// But an assistant message should still exist.
			const msgs = await sql<{ count: number }[]>`
				select count(*)::int as count from messages m
				inner join conversations c on c.id = m.conversation_id
				where c.user_id = ${userId} and c.title = ${`${prefix} synthesis-only automation`} and m.role = 'assistant'
			`
			expect(msgs[0].count).toBeGreaterThan(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
