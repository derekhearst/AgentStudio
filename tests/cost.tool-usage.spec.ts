import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

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

async function seedRun(prefix: string, userId: string) {
	const sql = getSql()
	const [convo] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label)
		values (${convo.id}, ${userId}, 'running', 'chat_stream', ${`${prefix} run`})
		returning id
	`
	return { conversationId: convo.id, runId: run.id }
}

test.describe('cost/tool-usage — non-LLM tool spend ledger', () => {
	test('schema accepts a row with all four context FKs and a unit/cost pair', async () => {
		const prefix = uniquePrefix('cost-tool-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const { runId } = await seedRun(prefix, userId)
		const taskId = randomUUID()
		const sql = getSql()
		try {
			await sql`
				insert into tool_usage (user_id, run_id, agent_id, task_id, tool_name, provider, unit_type, units, cost, metadata)
				values (${userId}, ${runId}, null, ${taskId}, 'web_search', 'serper', 'credit', '5', '0.005', '{}'::jsonb)
			`
			const [row] = await sql<{
				user_id: string
				run_id: string
				agent_id: string | null
				task_id: string
				tool_name: string
				provider: string | null
				unit_type: string
				units: string
				cost: string
			}[]>`
				select user_id, run_id, agent_id, task_id, tool_name, provider, unit_type, units, cost
				from tool_usage where run_id = ${runId}
			`
			expect(row.user_id).toBe(userId)
			expect(row.run_id).toBe(runId)
			expect(row.task_id).toBe(taskId)
			expect(row.tool_name).toBe('web_search')
			expect(row.provider).toBe('serper')
			expect(row.unit_type).toBe('credit')
			expect(parseFloat(row.units)).toBe(5)
			expect(parseFloat(row.cost)).toBeCloseTo(0.005, 6)
		} finally {
			await sql`delete from tool_usage where run_id = ${runId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('FK on run_id sets to null when the run is deleted (ledger row stays)', async () => {
		const prefix = uniquePrefix('cost-tool-fk-run')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const { runId } = await seedRun(prefix, userId)
		const sql = getSql()
		try {
			await sql`
				insert into tool_usage (user_id, run_id, tool_name, unit_type, units, cost)
				values (${userId}, ${runId}, 'browser', 'second', '12.5', '0.0001')
			`
			await sql`delete from chat_runs where id = ${runId}`
			const [row] = await sql<{ user_id: string; run_id: string | null; cost: string }[]>`
				select user_id, run_id, cost from tool_usage where user_id = ${userId}
				order by created_at desc limit 1
			`
			expect(row, 'tool ledger row must remain after run deletion').toBeDefined()
			expect(row.run_id, 'run_id should null out via on-delete-set-null').toBeNull()
			expect(row.user_id).toBe(userId)
		} finally {
			await sql`delete from tool_usage where user_id = ${userId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('combined LLM + tool spend SUM matches what each ledger contributes', async () => {
		const prefix = uniquePrefix('cost-tool-combined')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const { runId } = await seedRun(prefix, userId)
		const sql = getSql()
		try {
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id, run_id)
				values ('chat', 'anthropic/claude-sonnet-4', 100, 50, '0.05', ${userId}, ${runId})
			`
			await sql`
				insert into tool_usage (user_id, run_id, tool_name, unit_type, units, cost)
				values
					(${userId}, ${runId}, 'web_search', 'credit', '3', '0.003'),
					(${userId}, ${runId}, 'browser', 'second', '20', '0.002')
			`

			const [llm] = await sql<{ total: string }[]>`
				select coalesce(sum(cost::numeric), 0)::text as total from llm_usage where run_id = ${runId}
			`
			const [tool] = await sql<{ total: string }[]>`
				select coalesce(sum(cost::numeric), 0)::text as total from tool_usage where run_id = ${runId}
			`
			expect(parseFloat(llm.total)).toBeCloseTo(0.05, 5)
			expect(parseFloat(tool.total)).toBeCloseTo(0.005, 5)
			const combined = parseFloat(llm.total) + parseFloat(tool.total)
			expect(combined).toBeCloseTo(0.055, 5)
		} finally {
			await sql`delete from llm_usage where run_id = ${runId}`
			await sql`delete from tool_usage where run_id = ${runId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('cost defaults to 0 when omitted and units default to 0', async () => {
		const prefix = uniquePrefix('cost-tool-defaults')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into tool_usage (user_id, tool_name, unit_type)
				values (${userId}, 'shell', 'call')
			`
			const [row] = await sql<{ cost: string; units: string }[]>`
				select cost, units from tool_usage where user_id = ${userId} and tool_name = 'shell'
				order by created_at desc limit 1
			`
			expect(parseFloat(row.cost)).toBe(0)
			expect(parseFloat(row.units)).toBe(0)
		} finally {
			await sql`delete from tool_usage where user_id = ${userId} and tool_name = 'shell'`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
