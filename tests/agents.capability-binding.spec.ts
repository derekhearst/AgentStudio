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

async function insertAgent(prefix: string, _userId: string, config: Record<string, unknown> = {}) {
	const sql = getSql()
	const [agent] = await sql<{ id: string }[]>`
		insert into agents (id, name, role, system_prompt, model, status, config)
		values (
			${randomUUID()},
			${`${prefix} agent`},
			${'tester'},
			${'You are a test agent.'},
			${'anthropic/claude-sonnet-4'},
			'active'::agent_status,
			${sql.json(config)}
		)
		returning id
	`
	return agent.id
}

async function insertConversationAndRun(
	prefix: string,
	userId: string,
	agentId: string | null,
	enabledGroups: string[] | null = null,
) {
	const sql = getSql()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, agent_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, ${agentId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string; enabled_capability_groups: unknown }[]>`
		insert into chat_runs (id, conversation_id, user_id, agent_id, state, source, label, enabled_capability_groups)
		values (
			${randomUUID()},
			${conv.id},
			${userId},
			${agentId},
			'running'::chat_run_state,
			'chat_stream',
			${`${prefix} run`},
			${enabledGroups ? sql.json(enabledGroups) : sql.json(['core'])}
		)
		returning id, enabled_capability_groups
	`
	return { conversationId: conv.id, runId: run.id, enabledGroups: run.enabled_capability_groups }
}

function readGroups(value: unknown): string[] {
	if (Array.isArray(value)) return value as string[]
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value)
			return Array.isArray(parsed) ? parsed : []
		} catch {
			return []
		}
	}
	return []
}

test.describe('agents/capability-binding — agent.config.capabilityGroups round-trip', () => {
	test('an agent with config.capabilityGroups stores them as a jsonb array', async () => {
		const prefix = uniquePrefix('cap-bind-store')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agentId = await insertAgent(prefix, userId, { capabilityGroups: ['core', 'sandbox'] })
			const [row] = await sql<{ config: unknown }[]>`select config from agents where id = ${agentId}`
			const config = (row.config ?? {}) as { capabilityGroups?: string[] }
			expect(config.capabilityGroups).toEqual(['core', 'sandbox'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an agent with no capabilityGroups has no override (legacy back-compat)', async () => {
		const prefix = uniquePrefix('cap-bind-legacy')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const agentId = await insertAgent(prefix, userId, {})
			const [row] = await sql<{ config: unknown }[]>`select config from agents where id = ${agentId}`
			const config = (row.config ?? {}) as { capabilityGroups?: string[] }
			expect(config.capabilityGroups).toBeUndefined()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a chat_run can be seeded with the agent\'s capabilityGroups instead of defaulting to ["core"]', async () => {
		const prefix = uniquePrefix('cap-bind-seed-run')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		try {
			const agentId = await insertAgent(prefix, userId, { capabilityGroups: ['core', 'sandbox', 'skills'] })
			const { enabledGroups } = await insertConversationAndRun(prefix, userId, agentId, [
				'core',
				'sandbox',
				'skills',
			])
			expect(readGroups(enabledGroups)).toEqual(['core', 'sandbox', 'skills'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('agent config keeps unrelated keys intact when capabilityGroups changes', async () => {
		const prefix = uniquePrefix('cap-bind-merge')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Seed with workspace config + initial capabilityGroups.
			const agentId = await insertAgent(prefix, userId, {
				capabilityGroups: ['core', 'sandbox'],
				workspace: { mode: 'persistent', key: 'shared' },
			})
			// Simulate the updateAgentRecord merge: read existing, merge new keys.
			const [before] = await sql<{ config: unknown }[]>`select config from agents where id = ${agentId}`
			const existing = (before.config ?? {}) as Record<string, unknown>
			const next = { ...existing, capabilityGroups: ['core', 'media'] }
			await sql`update agents set config = ${sql.json(next)} where id = ${agentId}`
			const [after] = await sql<{ config: unknown }[]>`select config from agents where id = ${agentId}`
			const merged = (after.config ?? {}) as { capabilityGroups?: string[]; workspace?: Record<string, unknown> }
			expect(merged.capabilityGroups).toEqual(['core', 'media'])
			expect(merged.workspace).toEqual({ mode: 'persistent', key: 'shared' })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
