import { command, query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { getAgentDetail, listAgentsWithCounts, updateAgentRecord } from '$lib/agents/agents.server'

const agentIdSchema = z.string().uuid()
const updateAgentSchema = z
	.object({
		agentId: agentIdSchema,
		systemPrompt: z.string().trim().min(1).optional(),
		model: z.string().trim().min(1).optional(),
	})
	.refine((input) => input.systemPrompt !== undefined || input.model !== undefined, {
		message: 'Provide at least one field to update',
	})

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

export const updateAgentCommand = command(updateAgentSchema, async ({ agentId, systemPrompt, model }) => {
	return updateAgentRecord(agentId, {
		systemPrompt,
		model,
	})
})
