import { command, query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import {
	createAutomationRecord,
	deleteAutomationRecord,
	listAutomationsForUser,
	updateAutomationRecord,
} from '$lib/automation/automation.server'

const createAutomationSchema = z.object({
	agentId: z.string().uuid().nullable().optional(),
	description: z.string().trim().min(1).max(200),
	cronExpression: z.string().trim().min(1).max(120),
	prompt: z.string().trim().min(1),
	enabled: z.boolean().optional(),
	conversationMode: z.enum(['new_each_run', 'reuse']).optional(),
})

const updateAutomationSchema = z.object({
	id: z.string().uuid(),
	agentId: z.string().uuid().nullable().optional(),
	description: z.string().trim().min(1).max(200).optional(),
	cronExpression: z.string().trim().min(1).max(120).optional(),
	prompt: z.string().trim().min(1).optional(),
	enabled: z.boolean().optional(),
	conversationMode: z.enum(['new_each_run', 'reuse']).optional(),
})

const automationIdSchema = z.object({
	id: z.string().uuid(),
})

export const listAutomationsQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listAutomationsForUser(user.id)
})

export const createAutomationCommand = command(createAutomationSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return createAutomationRecord({
		userId: user.id,
		agentId: input.agentId ?? null,
		description: input.description,
		cronExpression: input.cronExpression,
		prompt: input.prompt,
		enabled: input.enabled,
		conversationMode: input.conversationMode,
	})
})

export const updateAutomationCommand = command(updateAutomationSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const { id, ...patch } = input
	return updateAutomationRecord(user.id, id, patch)
})

export const deleteAutomationCommand = command(automationIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	return deleteAutomationRecord(user.id, id)
})
