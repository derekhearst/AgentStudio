import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { isAgentPaused } from '$lib/agents/agent-status'
import { automations, type AutomationRunTrigger } from '$lib/automations/automation.schema'
import { computeNextRunAt } from './cron'
import { finishAutomationRun, startAutomationRun } from './automation-runs.server'

/**
 * #66 — an automation whose agent is paused does not run.
 *
 * Pausing an agent means two things: it is not offered for delegation, and nothing runs it
 * unattended (`$lib/agents/agent-status`). This is the second half for automations, checked
 * by `runAutomationById` for every trigger — the schedule, "Run now" and a monitor firing
 * alike — so there is one rule to explain rather than three.
 *
 * It applies whatever the automation's mode. A research or maintenance automation does not
 * run the agent's own loop, but it is still assigned to that agent, and "pausing an agent
 * stops the automations assigned to it" is the rule the Agents page states. An automation
 * with no agent is never affected.
 *
 * A skipped tick is recorded as `blocked`, the ledger status for "nothing is broken; a
 * switch held it back", with the reason in its error column so the run history says why.
 * It is not a failure: it neither counts toward the failure streak nor resets it. A
 * scheduled tick still moves the schedule on, so the dispatcher does not pick it up again
 * every minute while the agent stays paused. `last_run_at` is left alone, because the
 * automation did not run.
 */

export type PausedAutomationAgent = { id: string; name: string }

/** The automation's agent when it is paused; null when it has none or it is available. */
export async function findPausedAutomationAgent(agentId: string | null | undefined): Promise<PausedAutomationAgent | null> {
	if (!agentId) return null
	const [agent] = await db
		.select({ id: agents.id, name: agents.name, status: agents.status })
		.from(agents)
		.where(eq(agents.id, agentId))
		.limit(1)
	if (!agent || !isAgentPaused(agent.status)) return null
	return { id: agent.id, name: agent.name }
}

/** What the run history says about a skipped tick. */
export function pausedAgentSkipMessage(agentName: string): string {
	return `Skipped: agent "${agentName}" is paused. Resume it on the Agents page to let this automation run.`
}

export async function skipAutomationForPausedAgent(
	automation: typeof automations.$inferSelect,
	agent: PausedAutomationAgent,
	now: Date,
	context: { trigger: AutomationRunTrigger; attempt: number; jobId: string | null; preserveSchedule: boolean },
) {
	const ledgerRun = await startAutomationRun({
		automationId: automation.id,
		userId: automation.userId,
		mode: automation.mode,
		trigger: context.trigger,
		attempt: context.attempt,
		jobId: context.jobId,
		startedAt: now,
	})
	await finishAutomationRun(ledgerRun?.id, {
		status: 'blocked',
		error: pausedAgentSkipMessage(agent.name),
		finishedAt: now,
	})

	// Only the schedule's own tick moves the schedule, the same rule as a completed run.
	let nextRunAt: Date | null = automation.nextRunAt
	if (!context.preserveSchedule) {
		try {
			nextRunAt = computeNextRunAt(automation.cronExpression, now, automation.timezone)
		} catch {
			// A bad cron expression: leave the schedule alone, as the budget gate does.
		}
		await db.update(automations).set({ nextRunAt, updatedAt: now }).where(eq(automations.id, automation.id))
	}

	return {
		blocked: true as const,
		reason: 'agent_paused' as const,
		agentId: agent.id,
		conversationId: null,
		runId: null,
		nextRunAt: nextRunAt?.toISOString() ?? null,
	}
}
