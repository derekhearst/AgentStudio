import { command, query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { getAgentDetail, listAgentsWithCounts, updateAgentRecord } from '$lib/agents/agents.server'

const agentIdSchema = z.string().uuid()
const CAPABILITY_GROUP_NAMES = ['core', 'sandbox', 'skills', 'agents', 'media'] as const
const updateAgentSchema = z
	.object({
		agentId: agentIdSchema,
		systemPrompt: z.string().trim().min(1).optional(),
		model: z.string().trim().min(1).optional(),
		// Wave 2 #8 phase 4 — capability binding. Pass an empty array to clear the override and
		// fall back to the legacy "all tools" default for back-compat.
		capabilityGroups: z.array(z.enum(CAPABILITY_GROUP_NAMES)).optional(),
		allowedTools: z.array(z.string().trim().min(1)).optional(),
	})
	.refine(
		(input) =>
			input.systemPrompt !== undefined ||
			input.model !== undefined ||
			input.capabilityGroups !== undefined ||
			input.allowedTools !== undefined,
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
	return updateAgentRecord(input.agentId, {
		systemPrompt: input.systemPrompt,
		model: input.model,
		capabilityGroups: input.capabilityGroups,
		allowedTools: input.allowedTools,
	})
})
