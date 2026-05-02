import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

type LlmUsageRow = {
	id: string
	source: string
	model: string
	tokens_in: number
	tokens_out: number
	cost: string
	user_id: string | null
	run_id: string | null
	task_id: string | null
	agent_id: string | null
	metadata: Record<string, unknown>
}

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

async function seedAgent(prefix: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into agents (name, role, system_prompt, model, status)
		values (${`${prefix} agent`}, ${`${prefix} role`}, '', ${'anthropic/claude-sonnet-4'}, 'idle')
		returning id
	`
	return row.id
}

async function seedRun(prefix: string, userId: string, agentId: string | null) {
	const sql = getSql()
	const [convo] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, agent_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, ${agentId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, agent_id, state, source, label)
		values (${convo.id}, ${userId}, ${agentId}, 'running', 'chat_stream', ${`${prefix} run`})
		returning id
	`
	return { conversationId: convo.id, runId: run.id }
}

async function listUsageForUser(userId: string) {
	const sql = getSql()
	return sql<LlmUsageRow[]>`
		select id, source, model, tokens_in, tokens_out, cost, user_id, run_id, task_id, agent_id, metadata
		from llm_usage
		where user_id = ${userId}
		order by created_at desc
	`
}

test.describe('cost/linkage — llm_usage carries run/agent/user/task linkage', () => {
	test('schema accepts and round-trips all four foreign-key columns', async () => {
		const prefix = uniquePrefix('cost-linkage-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const agentId = await seedAgent(prefix)
		const { runId } = await seedRun(prefix, userId, agentId)
		const taskId = randomUUID()
		const sql = getSql()
		try {
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id, run_id, agent_id, task_id, metadata)
				values ('chat', 'anthropic/claude-sonnet-4', 100, 50, '0.0042', ${userId}, ${runId}, ${agentId}, ${taskId}, '{}'::jsonb)
			`

			const rows = await listUsageForUser(userId)
			expect(rows.length).toBeGreaterThan(0)
			const ours = rows.find((r) => r.run_id === runId)
			expect(ours).toBeDefined()
			expect(ours!.user_id).toBe(userId)
			expect(ours!.agent_id).toBe(agentId)
			expect(ours!.task_id).toBe(taskId)
			expect(ours!.tokens_in).toBe(100)
			expect(ours!.tokens_out).toBe(50)
		} finally {
			await sql`delete from llm_usage where user_id = ${userId} and run_id = ${runId}`
			await sql`delete from agents where id = ${agentId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('FK on run_id sets to null when the run is deleted (ledger row stays)', async () => {
		const prefix = uniquePrefix('cost-linkage-fk-run')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const agentId = await seedAgent(prefix)
		const { runId, conversationId } = await seedRun(prefix, userId, agentId)
		const sql = getSql()
		try {
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id, run_id, agent_id, metadata)
				values ('chat', 'anthropic/claude-sonnet-4', 10, 5, '0.001', ${userId}, ${runId}, ${agentId}, '{}'::jsonb)
			`
			await sql`delete from chat_runs where id = ${runId}`

			const [row] = await sql<{ run_id: string | null; user_id: string | null; agent_id: string | null }[]>`
				select run_id, user_id, agent_id from llm_usage
				where user_id = ${userId} and agent_id = ${agentId}
				order by created_at desc limit 1
			`
			expect(row, 'usage row must remain after run deletion (ledger is append-only)').toBeDefined()
			expect(row.run_id, 'run_id should null out via on-delete-set-null').toBeNull()
			expect(row.user_id).toBe(userId)
			expect(row.agent_id).toBe(agentId)
		} finally {
			const sql2 = getSql()
			await sql2`delete from llm_usage where user_id = ${userId}`
			await sql2`delete from agents where id = ${agentId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('per-run, per-agent, and per-task SUM(cost) queries match seeded ledger entries', async () => {
		const prefix = uniquePrefix('cost-linkage-summary')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const agentId = await seedAgent(prefix)
		const { runId } = await seedRun(prefix, userId, agentId)
		const taskId = randomUUID()
		const sql = getSql()
		try {
			await sql`
				insert into llm_usage (source, model, tokens_in, tokens_out, cost, user_id, run_id, agent_id, task_id, metadata)
				values
					('chat', 'anthropic/claude-sonnet-4', 200, 80, '0.05', ${userId}, ${runId}, ${agentId}, ${taskId}, '{}'::jsonb),
					('subagent', 'anthropic/claude-sonnet-4', 50, 20, '0.01', ${userId}, ${runId}, ${agentId}, ${taskId}, '{}'::jsonb)
			`

			const [byRunRow] = await sql<{ cost: string; tokens_in: number; tokens_out: number; count: number }[]>`
				select coalesce(sum(cost::numeric), 0)::text as cost,
				       coalesce(sum(tokens_in), 0)::int as tokens_in,
				       coalesce(sum(tokens_out), 0)::int as tokens_out,
				       count(*)::int as count
				from llm_usage where run_id = ${runId}
			`
			expect(parseFloat(byRunRow.cost)).toBeCloseTo(0.06, 5)
			expect(byRunRow.tokens_in).toBe(250)
			expect(byRunRow.tokens_out).toBe(100)
			expect(byRunRow.count).toBe(2)

			const [byAgentRow] = await sql<{ cost: string; count: number }[]>`
				select coalesce(sum(cost::numeric), 0)::text as cost, count(*)::int as count
				from llm_usage where agent_id = ${agentId}
			`
			expect(parseFloat(byAgentRow.cost)).toBeCloseTo(0.06, 5)
			expect(byAgentRow.count).toBe(2)

			const [byTaskRow] = await sql<{ cost: string; count: number }[]>`
				select coalesce(sum(cost::numeric), 0)::text as cost, count(*)::int as count
				from llm_usage where task_id = ${taskId}
			`
			expect(parseFloat(byTaskRow.cost)).toBeCloseTo(0.06, 5)
			expect(byTaskRow.count).toBe(2)
		} finally {
			await sql`delete from llm_usage where user_id = ${userId} and run_id = ${runId}`
			await sql`delete from agents where id = ${agentId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('live chat stream writes user_id, run_id, and agent_id on the cost row', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('cost-linkage-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const sql = getSql()
		const userId = await getActiveUserId()
		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} live`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
			returning id
		`
		try {
			const response = await fetch('http://127.0.0.1:4173' + `/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Cookie: (await context.cookies('http://127.0.0.1:4173')).map((c) => `${c.name}=${c.value}`).join('; '),
				},
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: reply with the single word "ok"`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			expect(response.body).toBeTruthy()
			// Drain to completion so logLlmUsage runs.
			const reader = response.body!.getReader()
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}

			const rows = await sql<{ user_id: string | null; run_id: string | null; agent_id: string | null; source: string }[]>`
				select user_id, run_id, agent_id, source
				from llm_usage
				where user_id = ${userId}
				  and metadata->>'conversationId' = ${conv.id}
				order by created_at desc
				limit 1
			`
			expect(rows.length, 'a chat usage row should exist').toBeGreaterThan(0)
			expect(rows[0].source).toBe('chat')
			expect(rows[0].user_id).toBe(userId)
			expect(rows[0].run_id, 'run_id should be populated by the stream handler').not.toBeNull()
			// agent_id is null because seeded conversation has no agent (orchestrator chat).
			expect(rows[0].agent_id).toBeNull()
		} finally {
			await sql`delete from llm_usage where user_id = ${userId} and metadata->>'conversationId' = ${conv.id}`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
