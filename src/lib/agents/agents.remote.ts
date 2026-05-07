import { command, query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { getAgentDetail, listAgentsWithCounts, updateAgentRecord } from '$lib/agents/agents.server'
import {
	ensureAgentIdentitySkill,
	getAgentIdentity,
	saveAgentIdentity,
	unlinkAgentIdentity,
} from '$lib/agents/identity-editor.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { auditAgentConfigUpdated } from '$lib/governance'

const agentIdSchema = z.string().uuid()
const CAPABILITY_GROUP_NAMES = ['core', 'sandbox', 'skills', 'agents', 'media', 'research', 'projects', 'source_control'] as const
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
		// Value is `.optional()` so missing keys are accepted — Zod 4's `z.record(K, V)`
		// without this rejects payloads that don't list every event from K.
		hooks: z.record(z.enum(HOOK_EVENT_NAMES), z.array(z.string().trim().min(1)).optional()).optional(),
		// Wave 4 #18 phase 4 — per-agent research config. Empty object clears the override.
		research: z
			.object({
				enabled: z.boolean().optional(),
				plannerModel: z.string().trim().min(1).max(120).optional(),
				synthesizerModel: z.string().trim().min(1).max(120).optional(),
				maxSubQuestions: z.number().int().min(1).max(8).optional(),
				urlsPerQuestion: z.number().int().min(1).max(5).optional(),
				maxFetchChars: z.number().int().min(5_000).max(100_000).optional(),
			})
			.optional(),
		// Wave 5 #22 phase 2 — link to a skill whose content overrides systemPrompt at runtime.
		// Pass null to clear; pass a uuid to link.
		identitySkillId: z.string().uuid().nullable().optional(),
	})
	.refine(
		(input) =>
			input.systemPrompt !== undefined ||
			input.model !== undefined ||
			input.capabilityGroups !== undefined ||
			input.allowedTools !== undefined ||
			input.hooks !== undefined ||
			input.research !== undefined ||
			input.identitySkillId !== undefined,
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
		.select({
			id: agents.id,
			name: agents.name,
			status: agents.status,
			builtinKey: agents.builtinKey,
			role: agents.role,
		})
		.from(agents)
		.orderBy(asc(agents.createdAt))
})

/* ── Wave 5 #22 phase 3 — identity editor ─────────────────────────────────── */

export const getAgentIdentityQuery = query(agentIdSchema, async (agentId) => {
	requireAuthenticatedRequestUser()
	return getAgentIdentity(agentId)
})

export const ensureAgentIdentityCommand = command(z.object({ agentId: agentIdSchema }), async ({ agentId }) => {
	requireAuthenticatedRequestUser()
	return ensureAgentIdentitySkill(agentId)
})

const saveIdentitySchema = z.object({
	agentId: agentIdSchema,
	content: z.string().trim().min(1).max(50_000),
})
export const saveAgentIdentityCommand = command(saveIdentitySchema, async ({ agentId, content }) => {
	requireAuthenticatedRequestUser()
	return saveAgentIdentity(agentId, content)
})

export const unlinkAgentIdentityCommand = command(z.object({ agentId: agentIdSchema }), async ({ agentId }) => {
	requireAuthenticatedRequestUser()
	await unlinkAgentIdentity(agentId)
	return { ok: true as const }
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
		research: input.research,
		identitySkillId: input.identitySkillId,
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
