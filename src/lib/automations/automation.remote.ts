import { command, query } from '$app/server'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { withUserInputErrors } from '$lib/server/user-input-error'
import {
	createAutomationRecord,
	deleteAutomationRecord,
	listAutomationsForUser,
	runAutomationNow,
	updateAutomationRecord,
} from '$lib/automations/automation.server'
import { listAutomationRunsForUser } from '$lib/automations/automation-runs.server'
import { isValidTimeZone } from '$lib/automations/cron'

const automationModeSchema = z.enum(['chat_followup', 'research', 'maintenance'])
const automationOutputTargetSchema = z.enum(['chat_session', 'review_inbox'])

// #30 — the cron expression is wall-clock, so the zone is part of the schedule. Validated
// against the runtime's own tz database so a typo fails at the form instead of silently
// scheduling in the wrong hemisphere.
const timezoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.refine(isValidTimeZone, { message: 'Must be an IANA time zone name, e.g. America/Boise' })

const createAutomationSchema = z.object({
	agentId: z.string().uuid().nullable().optional(),
	description: z.string().trim().min(1).max(200),
	cronExpression: z.string().trim().min(1).max(120),
	timezone: timezoneSchema.optional(),
	prompt: z.string().trim().min(1),
	enabled: z.boolean().optional(),
	conversationMode: z.enum(['new_each_run', 'reuse']).optional(),
	mode: automationModeSchema.optional(),
	outputTarget: automationOutputTargetSchema.optional(),
	repositoryId: z.string().uuid().nullable().optional(),
})

const updateAutomationSchema = z.object({
	id: z.string().uuid(),
	agentId: z.string().uuid().nullable().optional(),
	description: z.string().trim().min(1).max(200).optional(),
	cronExpression: z.string().trim().min(1).max(120).optional(),
	timezone: timezoneSchema.optional(),
	prompt: z.string().trim().min(1).optional(),
	enabled: z.boolean().optional(),
	conversationMode: z.enum(['new_each_run', 'reuse']).optional(),
	mode: automationModeSchema.optional(),
	outputTarget: automationOutputTargetSchema.optional(),
	repositoryId: z.string().uuid().nullable().optional(),
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
	return withUserInputErrors(() =>
		createAutomationRecord({
			userId: user.id,
			agentId: input.agentId ?? null,
			description: input.description,
			cronExpression: input.cronExpression,
			timezone: input.timezone,
			prompt: input.prompt,
			enabled: input.enabled,
			conversationMode: input.conversationMode,
			mode: input.mode,
			outputTarget: input.outputTarget,
			repositoryId: input.repositoryId ?? null,
		}),
	)
})

export const updateAutomationCommand = command(updateAutomationSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	const { id, ...patch } = input
	return withUserInputErrors(() => updateAutomationRecord(user.id, id, patch))
})

export const deleteAutomationCommand = command(automationIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	return deleteAutomationRecord(user.id, id)
})

/**
 * #31 — "Run now". Queues a manual execution of an automation the caller owns. Returns the
 * queued job id; the run itself lands in the run history a moment later. Does not move
 * `next_run_at`, and works on a disabled automation so a fix can be verified.
 */
export const runAutomationNowCommand = command(automationIdSchema, async ({ id }) => {
	const user = requireAuthenticatedRequestUser()
	const queued = await runAutomationNow(user.id, id)
	if (!queued) error(404, 'Automation not found')
	return queued
})

const automationRunsSchema = z.object({
	automationId: z.string().uuid(),
	limit: z.number().int().min(1).max(100).optional(),
})

/** #31 — run history for one automation, newest first. */
export const listAutomationRunsQuery = query(automationRunsSchema, async ({ automationId, limit }) => {
	const user = requireAuthenticatedRequestUser()
	return listAutomationRunsForUser(user.id, { automationId, limit })
})
