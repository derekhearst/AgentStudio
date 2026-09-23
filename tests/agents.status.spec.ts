import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getBuiltinChatAgentId, getSql, pollDb, seedAgent, uniquePrefix } from './helpers'
import {
	AGENT_PAUSED_HELP,
	agentAvailability,
	agentPauseAction,
	agentStatusHint,
	agentStatusLabel,
	canPauseAgent,
	isAgentPaused,
	pauseRefusal,
} from '../src/lib/agents/agent-status'

/**
 * #66 — what an agent's status means, and who may change it.
 *
 * The column holds `active`, `idle` or `paused`, and before this the app read it three
 * different ways: the delegation filter treated anything but `paused` as offered, the
 * orchestrator's prompt listed only `active` agents, and the pages printed the raw value.
 * The rule is now one module — paused or available — and these pin it, then pin the server
 * setter that the Pause button and the model's pause_agent / resume_agent tools share.
 */

const custom = { builtinKey: null, kind: 'worker' }
const builtin = { builtinKey: 'chat', kind: 'orchestrator' }
const evaluator = { builtinKey: null, kind: 'evaluator' }

test.describe('agents/status — the rule', () => {
	test('paused is the only status that means anything; idle and active are both available', () => {
		expect(isAgentPaused('paused')).toBe(true)
		for (const status of ['idle', 'active', null, undefined, '']) {
			expect(isAgentPaused(status), String(status)).toBe(false)
			expect(agentAvailability(status)).toBe('available')
			expect(agentStatusLabel(status)).toBe('Available')
		}
		expect(agentAvailability('paused')).toBe('paused')
		expect(agentStatusLabel('paused')).toBe('Paused')
	})

	test('only a user-created agent may be paused', () => {
		expect(canPauseAgent(custom)).toBe(true)
		expect(pauseRefusal(custom)).toBeNull()

		// Built-ins are never delegated to, so "paused" would mean something else for them.
		expect(canPauseAgent(builtin)).toBe(false)
		expect(pauseRefusal(builtin)).toMatch(/Built-in agents cannot be paused/)
		// Evaluators run whatever their status, so a pause would promise what it cannot do.
		expect(canPauseAgent(evaluator)).toBe(false)
		expect(pauseRefusal(evaluator)).toMatch(/Evaluator agents cannot be paused/)
	})

	test('the control: Resume for any paused agent, Pause only where pausing is allowed', () => {
		expect(agentPauseAction({ ...custom, status: 'idle' })).toBe('pause')
		expect(agentPauseAction({ ...custom, status: 'active' })).toBe('pause')
		expect(agentPauseAction({ ...custom, status: 'paused' })).toBe('resume')

		expect(agentPauseAction({ ...builtin, status: 'idle' })).toBeNull()
		expect(agentPauseAction({ ...evaluator, status: 'active' })).toBeNull()
		// The model's tool could pause a built-in before #66. It must not be stranded there.
		expect(agentPauseAction({ ...builtin, status: 'paused' })).toBe('resume')
	})

	test('the explanation says what pausing does and does not stop', () => {
		expect(agentStatusHint({ ...custom, status: 'paused' })).toBe(AGENT_PAUSED_HELP)
		expect(AGENT_PAUSED_HELP).toMatch(/delegation/)
		expect(AGENT_PAUSED_HELP).toMatch(/automations and monitors/)
		expect(AGENT_PAUSED_HELP).toMatch(/still chat with them directly/)
		expect(agentStatusHint({ ...builtin, status: 'idle' })).toMatch(/always available/)
		expect(agentStatusHint({ ...custom, status: 'idle' })).toMatch(/^Available/)
	})
})

test.describe('agents/status — setAgentPaused, shared by the button and the model tools', () => {
	async function statusOf(agentId: string) {
		const [row] = await getSql()<{ status: string }[]>`select status::text as status from agents where id = ${agentId}`
		return row?.status ?? null
	}

	async function auditRows(agentId: string) {
		return getSql()<{ actor_user_id: string | null; before_state: { status: string }; after_state: { status: string } }[]>`
			select actor_user_id, before_state, after_state from audit_events
			where action = 'agent.status.changed' and target_id = ${agentId}
			order by created_at asc
		`
	}

	test('pause and resume write the status and an audit row naming who did it', async () => {
		const prefix = uniquePrefix('agent-status-setter')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const { setAgentPaused } = await import('../src/lib/agents/agents.server')
		const agent = await seedAgent(prefix, { status: 'idle' })
		try {
			const paused = await setAgentPaused(agent.id, true, userId)
			expect(paused.ok && paused.agent.status).toBe('paused')
			expect(await statusOf(agent.id)).toBe('paused')

			const resumed = await setAgentPaused(agent.id, false, userId)
			expect(resumed.ok && resumed.agent.status).toBe('active')

			// The audit write is fire-and-forget, so wait for it rather than assume it landed.
			const rows = await pollDb(() => auditRows(agent.id), (r) => r.length === 2, { description: 'two status audit rows' })
			expect(rows.map((r) => [r.before_state.status, r.after_state.status])).toEqual([
				['idle', 'paused'],
				['paused', 'active'],
			])
			// It used to be null on every row: the setter had no way to be told.
			expect(rows.every((r) => r.actor_user_id === userId)).toBe(true)
		} finally {
			await getSql()`delete from audit_events where target_id = ${agent.id}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('resuming an agent that is not paused changes nothing and records nothing', async () => {
		const prefix = uniquePrefix('agent-status-noop')
		await cleanupPrefixedRecords(prefix)
		const { setAgentPaused } = await import('../src/lib/agents/agents.server')
		const agent = await seedAgent(prefix, { status: 'idle' })
		try {
			const result = await setAgentPaused(agent.id, false)
			expect(result.ok && result.agent.status).toBe('idle')
			await new Promise((r) => setTimeout(r, 300))
			expect(await auditRows(agent.id)).toHaveLength(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a built-in is refused and left as it was; an unknown id is not found', async () => {
		const { setAgentPaused } = await import('../src/lib/agents/agents.server')
		const chatId = await getBuiltinChatAgentId()
		const before = await statusOf(chatId)

		const refused = await setAgentPaused(chatId, true)
		expect(refused).toMatchObject({ ok: false, reason: 'not_pausable' })
		expect(await statusOf(chatId)).toBe(before)

		expect(await setAgentPaused(randomUUID(), true)).toMatchObject({ ok: false, reason: 'not_found' })
	})

	test('a built-in someone paused before #66 can still be resumed', async () => {
		// A stand-in, not the real Chat agent: this must not touch the shared built-ins.
		const prefix = uniquePrefix('agent-status-stray')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		const { setAgentPaused } = await import('../src/lib/agents/agents.server')
		const [agent] = await sql<{ id: string }[]>`
			insert into agents (name, role, system_prompt, model, status, kind, builtin_key)
			values (${`${prefix} stray`}, ${`${prefix} role`}, 'prompt', 'claude-sonnet-5', 'paused', 'orchestrator', ${`${prefix}-key`})
			returning id
		`
		try {
			const result = await setAgentPaused(agent.id, false)
			expect(result.ok && result.agent.status).toBe('active')
		} finally {
			await sql`delete from audit_events where target_id = ${agent.id}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the model tools are held to the same rule', async () => {
		const prefix = uniquePrefix('agent-status-tools')
		await cleanupPrefixedRecords(prefix)
		const { agentAutomationHandlers } = await import('../src/lib/tools/handlers/agents-automations.server')
		const ctx = { userId: await getActiveUserId(), runId: null, startedAt: Date.now() }
		const agent = await seedAgent(prefix, { status: 'idle' })
		try {
			const refused = await agentAutomationHandlers.pause_agent(
				{ name: 'pause_agent', arguments: { agentId: await getBuiltinChatAgentId() } },
				ctx,
			)
			expect(refused.success).toBe(false)
			expect(refused.error).toMatch(/Built-in agents cannot be paused/)

			const paused = await agentAutomationHandlers.pause_agent({ name: 'pause_agent', arguments: { agentId: agent.id } }, ctx)
			expect(paused.success).toBe(true)
			expect(await statusOf(agent.id)).toBe('paused')

			const resumed = await agentAutomationHandlers.resume_agent({ name: 'resume_agent', arguments: { agentId: agent.id } }, ctx)
			expect(resumed.success).toBe(true)
			expect(await statusOf(agent.id)).toBe('active')
		} finally {
			await getSql()`delete from audit_events where target_id = ${agent.id}`
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('agents/status — the orchestrator prompt and Options.agents agree', () => {
	test('the prompt keeps no roster of its own', async () => {
		// It used to list `status = 'active'` agents by id prefix: on a fresh install that was
		// the Default Evaluator alone — never offered for delegation — while every custom
		// agent the run did offer was missing. An `active` agent is seeded here so a roster
		// built from the column would show up.
		const prefix = uniquePrefix('agent-status-roster')
		await cleanupPrefixedRecords(prefix)
		const { buildOrchestratorPrompt, ORCHESTRATOR_DELEGATION_NOTE } = await import('../src/lib/agents/orchestrator')
		await seedAgent(prefix, { name: `${prefix} Roster`, status: 'active' })
		try {
			const prompt = await buildOrchestratorPrompt()
			expect(prompt).toContain(ORCHESTRATOR_DELEGATION_NOTE)
			expect(prompt).not.toContain('Available agents')
			expect(prompt).not.toContain(`${prefix} Roster`)
			expect(prompt).not.toContain('Default Evaluator')
			// It points at the one list that is real: the delegation tool's own description.
			expect(ORCHESTRATOR_DELEGATION_NOTE).toMatch(/Agent tool/)
			expect(ORCHESTRATOR_DELEGATION_NOTE).toMatch(/subagent_type/)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
