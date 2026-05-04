import { command, query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { getAgentDetail, listAgentsWithCounts, updateAgentRecord } from '$lib/agents/agents.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { auditAgentConfigUpdated } from '$lib/governance'

const agentIdSchema = z.string().uuid()
const CAPABILITY_GROUP_NAMES = ['core', 'sandbox', 'skills', 'agents', 'media', 'research', 'projects'] as const
const HOOK_EVENT_NAMES = [
	'before_run',
	'after_run',
	'before_round',
	'after_round',
	'before_tool',
	'after_tool',
	'on_compact',
	'on_evaluator',
	'on_subagent_spawn',
	'on_approval_required',
	'on_user_question',
	'on_run_failed',
	'on_skill_loaded',
	'on_tool_output_archived',
] as const
const updateAgentSchema = z
	.object({
		agentId: agentIdSchema,
		systemPrompt: z.string().trim().min(1).optional(),
		model: z.string().trim().min(1).optional(),
		// Wave 2 #8 phase 4 — capability binding. Pass an empty array to clear the override and
		// fall back to the legacy "all tools" default for back-compat.
		capabilityGroups: z.array(z.enum(CAPABILITY_GROUP_NAMES)).optional(),
		allowedTools: z.array(z.string().trim().min(1)).optional(),
		// Wave 3 #13 phase 4 — per-agent hook bindings. Map of `event → hookRef[]`. Empty object
		// clears all bindings; empty array per-event drops that event's overrides.
		hooks: z.record(z.enum(HOOK_EVENT_NAMES), z.array(z.string().trim().min(1))).optional(),
	})
	.refine(
		(input) =>
			input.systemPrompt !== undefined ||
			input.model !== undefined ||
			input.capabilityGroups !== undefined ||
			input.allowedTools !== undefined ||
			input.hooks !== undefined,
		{ message: 'Provide at least one field to update' },
	)

export const listAgents = query(async () => {
	return listAgentsWithCounts()
})

export const getAgent = query(agentIdSchema, async (agentId) => {
	return getAgentDetail(agentId)
})

export const getAgentChoices = query(async () => {
	return db
		.select({ id: agents.id, name: agents.name, status: agents.status })
		.from(agents)
		.orderBy(asc(agents.createdAt))
})

export const updateAgentCommand = command(updateAgentSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	// Snapshot the audit-relevant fields BEFORE the update so the diff is meaningful.
	const [before] = await db
		.select({ systemPrompt: agents.systemPrompt, model: agents.model, config: agents.config })
		.from(agents)
		.where(eq(agents.id, input.agentId))
		.limit(1)
	const updated = await updateAgentRecord(input.agentId, {
		systemPrompt: input.systemPrompt,
		model: input.model,
		capabilityGroups: input.capabilityGroups,
		allowedTools: input.allowedTools,
		hooks: input.hooks,
	})
	if (updated && before) {
		void auditAgentConfigUpdated({
			actorUserId: user.id,
			agentId: input.agentId,
			beforeState: { systemPrompt: before.systemPrompt, model: before.model, config: before.config },
			afterState: { systemPrompt: updated.systemPrompt, model: updated.model, config: updated.config },
		})
	}
	return updated
})
