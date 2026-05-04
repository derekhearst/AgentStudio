import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { skills } from '$lib/skills/skills.schema'
import {
	ORCHESTRATOR_IDENTITY_DEFAULT,
	ORCHESTRATOR_IDENTITY_SKILL_ID,
} from '$lib/agents/identity-seed.server'
import { expandFragments } from '$lib/agents/fragment-expand'

/**
 * Orchestrator identity — injected as system message for conversations
 * where agentId IS NULL (direct user↔orchestrator chat).
 *
 * Wave 5 #22 phase 1 — content lives in the `system/orchestrator-identity` skill (boot-
 * seeded with a fixed UUID). buildOrchestratorPrompt reads from the skill at runtime so
 * operators can edit the prompt via /skills without a deploy. The TS default is a fallback
 * when the skill is missing or disabled — defense in depth so a misconfigured skill row
 * can never break orchestrator chat.
 */

/**
 * Load the orchestrator identity content from the seeded skill, falling back to the TS
 * default when the skill is missing/disabled. Always returns a non-empty string.
 */
async function loadOrchestratorIdentity(): Promise<string> {
	let raw = ORCHESTRATOR_IDENTITY_DEFAULT
	try {
		const [skill] = await db
			.select({ content: skills.content, enabled: skills.enabled })
			.from(skills)
			.where(eq(skills.id, ORCHESTRATOR_IDENTITY_SKILL_ID))
			.limit(1)
		if (skill && skill.enabled && skill.content.trim().length > 0) {
			raw = skill.content
		}
	} catch (err) {
		console.warn('[orchestrator] failed to load identity skill, using TS fallback', err)
	}
	// Wave 5 #22 phase 5 — expand `@import skill-name` fragments. Best-effort: a lookup
	// failure leaves a `<!-- @import:missing ... -->` marker in the assembled prompt rather
	// than throwing.
	try {
		return await expandFragments(raw, lookupFragmentByName)
	} catch (err) {
		console.warn('[orchestrator] fragment expansion failed, using raw content', err)
		return raw
	}
}

async function lookupFragmentByName(name: string): Promise<string | null> {
	try {
		const [row] = await db
			.select({ content: skills.content, enabled: skills.enabled })
			.from(skills)
			.where(eq(skills.name, name))
			.limit(1)
		if (!row || !row.enabled) return null
		return row.content
	} catch {
		return null
	}
}

/**
 * Build the orchestrator system prompt with the current agent roster.
 */
export async function buildOrchestratorPrompt(): Promise<string> {
	const [identity, roster] = await Promise.all([
		loadOrchestratorIdentity(),
		db
			.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
			.from(agents)
			.where(eq(agents.status, 'active'))
			.orderBy(asc(agents.name)),
	])

	const sections = [identity]

	if (roster.length > 0) {
		const rosterLines = roster.map((a) => `- **${a.name}** (${a.id.slice(0, 8)}): ${a.role}`)
		sections.push(`Available agents:\n${rosterLines.join('\n')}`)
	} else {
		sections.push('No specialized agents are currently active. Handle all tasks directly.')
	}

	return sections.join('\n\n')
}

/**
 * Simple heuristic: does this message likely need a multi-step plan?
 * Returns true if the orchestrator should consider planning.
 */
export function looksComplex(userMessage: string): boolean {
	const lower = userMessage.toLowerCase()
	const complexSignals = [
		'create a',
		'build a',
		'set up',
		'analyze',
		'research',
		'compare',
		'investigate',
		'write a report',
		'generate a',
		'deploy',
		'migrate',
		'refactor',
		'implement',
		'design',
		'plan',
		'schedule',
		'automate',
	]
	return complexSignals.some((signal) => lower.includes(signal)) || userMessage.length > 300
}
