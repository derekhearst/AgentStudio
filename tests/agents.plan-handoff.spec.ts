import { eq } from 'drizzle-orm'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, seedAgent, uniquePrefix } from './helpers'
import { BUILTIN_AGENT_IDS, READ_ONLY_TOOL_NAMES, builtinHandoffNote } from '../src/lib/agents/builtin-agents.server'
import { toolDescriptions, toolSchemas } from '../src/lib/tools/tool-schemas'
import { toolCapabilities } from '../src/lib/engine/permission-mode'

/**
 * The Plan / Research handoff needs an agent's full id, and the model had no way to get one.
 *
 * `request_plan_approval` takes `implementerAgentId: uuid`. The Plan persona said to find one
 * with `list_agents`, which did not exist; the only roster the model ever saw printed an
 * eight-character prefix Zod rejects; and the Research persona named a `research-runner`
 * agent that was never seeded. So the handoff could not complete. These pin the two ways the
 * model now learns an id: a read-only `list_agents` tool, and the built-in ids stated in the
 * Plan and Research posture by code rather than by the operator-owned persona text.
 */

test.describe('agents/plan-handoff — list_agents', () => {
	test('is a registered, read-only tool the read-only built-ins are granted', () => {
		expect(toolSchemas.list_agents).toBeTruthy()
		expect(toolDescriptions.list_agents).toMatch(/full id/)
		// Read-only by classification, so plan mode and the read-only posture both allow it.
		expect([...toolCapabilities('list_agents')]).toEqual(['read'])
		expect(READ_ONLY_TOOL_NAMES).toContain('list_agents')
	})

	test('returns full ids, built-ins first, that request_plan_approval accepts', async () => {
		const prefix = uniquePrefix('plan-handoff-roster')
		await cleanupPrefixedRecords(prefix)
		const { agentAutomationHandlers } = await import('../src/lib/tools/handlers/agents-automations.server')
		const ctx = { userId: await getActiveUserId(), runId: null, startedAt: Date.now() }
		const custom = await seedAgent(prefix, { status: 'paused' })
		try {
			const outcome = await agentAutomationHandlers.list_agents({ name: 'list_agents', arguments: {} }, ctx)
			expect(outcome.success).toBe(true)
			const roster = outcome.result as Array<{
				id: string
				name: string
				builtinKey: string | null
				availability: string
			}>

			const firstCustom = roster.findIndex((a) => a.builtinKey === null)
			const lastBuiltin = roster.map((a) => a.builtinKey !== null).lastIndexOf(true)
			expect(lastBuiltin, 'built-ins are listed ahead of user-created agents').toBeLessThan(firstCustom)

			const chat = roster.find((a) => a.builtinKey === 'chat')
			expect(chat?.id).toBe(BUILTIN_AGENT_IDS.chat)
			expect(roster.find((a) => a.id === custom.id)?.availability).toBe('paused')

			// The id round-trips into the handoff's own schema — the prefix the old roster
			// printed did not.
			for (const agent of roster) {
				const parsed = toolSchemas.request_plan_approval.safeParse({ path: 'PLAN.md', implementerAgentId: agent.id })
				expect(parsed.success, agent.name).toBe(true)
			}
			expect(
				toolSchemas.request_plan_approval.safeParse({ path: 'PLAN.md', implementerAgentId: chat!.id.slice(0, 8) }).success,
			).toBe(false)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('agents/plan-handoff — the posture states the built-in ids', () => {
	test('Plan and Research get the handoff note; the other built-ins do not', () => {
		for (const key of ['plan', 'research'] as const) {
			const note = builtinHandoffNote(key)
			expect(note, key).toContain(BUILTIN_AGENT_IDS.chat)
			expect(note, key).toContain(BUILTIN_AGENT_IDS.autonomous)
			expect(note, key).toContain('list_agents')
		}
		// Research's persona names a runner agent that does not exist; the note says so.
		expect(builtinHandoffNote('research')).toMatch(/no separate research-runner agent/)
		for (const key of ['chat', 'autonomous', null, undefined]) {
			expect(builtinHandoffNote(key), String(key)).toBeNull()
		}
	})

	test("the Plan agent's posture slot carries it, whatever the stored persona says", async () => {
		const [{ db }, { agents }, { buildBuiltinAgentPostureSlot }] = await Promise.all([
			import('../src/lib/db.server'),
			import('../src/lib/agents/agents.schema'),
			import('../src/lib/chat/stream-slots.server'),
		])
		const [plan] = await db.select().from(agents).where(eq(agents.id, BUILTIN_AGENT_IDS.plan)).limit(1)
		test.skip(!plan, 'Plan agent not seeded yet')
		const slot = await buildBuiltinAgentPostureSlot(plan)
		expect(slot?.content).toContain(builtinHandoffNote('plan')!)
	})
})
