import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { skills } from '$lib/skills/skills.schema'

/**
 * Wave 5 #22 phase 3 — `/agents/[id]/identity` editor backing.
 *
 * Handles three concerns the route needs:
 *   - Read the agent + linked identity skill in one round-trip (`getAgentIdentity`)
 *   - Auto-create + link a paired skill if none exists (`ensureAgentIdentitySkill`)
 *   - Save the identity content (writes to the linked skill, not `agents.systemPrompt`)
 *
 * The runtime composer (`buildAgentDefinition`) already prefers the linked skill's content
 * over the legacy `agents.systemPrompt` column — this module just makes the link easy to
 * create + edit from the UI without touching the underlying schema.
 */

const IDENTITY_TAG = 'agent-identity'

function slugifyAgentName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'agent'
	)
}

function buildIdentitySkillName(agentId: string, agentName: string): string {
	const slug = slugifyAgentName(agentName)
	const idShort = agentId.slice(0, 8)
	return `agent/${slug}-${idShort}/identity`
}

export type AgentIdentityRecord = {
	agent: {
		id: string
		name: string
		role: string
		systemPrompt: string
		model: string
		identitySkillId: string | null
	}
	skill: {
		id: string
		name: string
		content: string
		description: string
		enabled: boolean
		updatedAt: Date
	} | null
}

export async function getAgentIdentity(agentId: string): Promise<AgentIdentityRecord | null> {
	const [agent] = await db
		.select({
			id: agents.id,
			name: agents.name,
			role: agents.role,
			systemPrompt: agents.systemPrompt,
			model: agents.model,
			identitySkillId: agents.identitySkillId,
		})
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1)
	if (!agent) return null

	let skill: AgentIdentityRecord['skill'] = null
	if (agent.identitySkillId) {
		const [row] = await db
			.select({
				id: skills.id,
				name: skills.name,
				content: skills.content,
				description: skills.description,
				enabled: skills.enabled,
				updatedAt: skills.updatedAt,
			})
			.from(skills)
			.where(eq(skills.id, agent.identitySkillId))
			.limit(1)
		skill = row ?? null
	}

	return { agent, skill }
}

/**
 * Auto-create a paired identity skill seeded from `agents.systemPrompt` and link it
 * back to the agent. Idempotent — if the agent is already linked + the skill exists,
 * returns the existing record without modification. Returns the resulting record.
 *
 * Naming pattern: `agent/<slug>-<shortid>/identity` — the short id keeps it unique
 * across renames + cross-user collisions.
 */
export async function ensureAgentIdentitySkill(agentId: string): Promise<AgentIdentityRecord> {
	const existing = await getAgentIdentity(agentId)
	if (!existing) {
		throw new Error(`Agent ${agentId} not found`)
	}
	if (existing.skill) return existing

	const skillName = buildIdentitySkillName(agentId, existing.agent.name)
	const description = `Identity prompt for "${existing.agent.name}". Edits take effect on the next run without redeploy.`
	const seedContent = existing.agent.systemPrompt.trim().length > 0
		? existing.agent.systemPrompt
		: `You are ${existing.agent.name}.\n\nYour role: ${existing.agent.role}.`

	const [createdSkill] = await db
		.insert(skills)
		.values({
			name: skillName,
			description,
			content: seedContent,
			tags: [IDENTITY_TAG],
			enabled: true,
		})
		.returning({
			id: skills.id,
			name: skills.name,
			content: skills.content,
			description: skills.description,
			enabled: skills.enabled,
			updatedAt: skills.updatedAt,
		})
	if (!createdSkill) {
		throw new Error('Failed to create identity skill')
	}

	await db.update(agents).set({ identitySkillId: createdSkill.id }).where(eq(agents.id, agentId))

	return {
		agent: { ...existing.agent, identitySkillId: createdSkill.id },
		skill: createdSkill,
	}
}

/**
 * Save new identity content. Requires the agent to already have a linked skill (call
 * `ensureAgentIdentitySkill` first). Writes only the skill content + updatedAt — the
 * runtime picks up the change on the next chat run.
 */
export async function saveAgentIdentity(agentId: string, content: string): Promise<AgentIdentityRecord> {
	const trimmed = content.trim()
	if (trimmed.length === 0) {
		throw new Error('Identity content cannot be empty')
	}
	const record = await getAgentIdentity(agentId)
	if (!record) {
		throw new Error(`Agent ${agentId} not found`)
	}
	if (!record.skill) {
		throw new Error('Agent has no linked identity skill — call ensureAgentIdentitySkill first')
	}

	const [updated] = await db
		.update(skills)
		.set({ content: trimmed, updatedAt: new Date() })
		.where(eq(skills.id, record.skill.id))
		.returning({
			id: skills.id,
			name: skills.name,
			content: skills.content,
			description: skills.description,
			enabled: skills.enabled,
			updatedAt: skills.updatedAt,
		})

	return {
		agent: record.agent,
		skill: updated ?? record.skill,
	}
}

/**
 * Unlink the agent's identity skill (does not delete the skill — operators can re-link
 * later or clean up via /skills/[id]). The runtime falls back to `agents.systemPrompt`.
 */
export async function unlinkAgentIdentity(agentId: string): Promise<void> {
	await db.update(agents).set({ identitySkillId: null }).where(eq(agents.id, agentId))
}
