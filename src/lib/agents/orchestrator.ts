import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'

/**
 * Orchestrator identity — injected as system message for conversations
 * where agentId IS NULL (direct user↔orchestrator chat).
 */

const ORCHESTRATOR_IDENTITY = `You are the Orchestrator — the user's primary AI assistant in AgentStudio.

Your responsibilities:
- Answer questions directly when you can (simple path)
- For complex, multi-step work, propose a plan with specific agents before executing
- Delegate sub-tasks to specialized agents when their expertise is needed
- Synthesize sub-agent results into coherent responses

Behavior:
- Be concise and helpful. Don't over-explain.
- When a task is simple (lookup, chat, brainstorming), handle it yourself — no plan needed.
- When a task is complex (multi-step, needs tools, specialized knowledge), propose a plan first.
- Plans list the steps and which agent handles each. Wait for user approval before executing.
- After sub-agents complete, synthesize their results and present a unified response.
`

/**
 * Build the orchestrator system prompt with the current agent roster.
 */
export async function buildOrchestratorPrompt(): Promise<string> {
	const roster = await db
		.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
		.from(agents)
		.where(eq(agents.status, 'active'))
		.orderBy(asc(agents.name))

	const sections = [ORCHESTRATOR_IDENTITY]

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
