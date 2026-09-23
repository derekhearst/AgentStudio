import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { agents } from '$lib/agents/agents.schema'
import { DEFAULT_TIMEZONE, computeNextRunAt } from '$lib/automations/cron'
import { getLatestRunSummaries } from '$lib/automations/automation-runs.server'
import { UserInputError } from '$lib/server/user-input-error'

export async function listAutomationsForUser(userId: string) {
	const rows = await db
		.select({
			id: automations.id,
			description: automations.description,
			cronExpression: automations.cronExpression,
			timezone: automations.timezone,
			prompt: automations.prompt,
			enabled: automations.enabled,
			conversationMode: automations.conversationMode,
			conversationId: automations.conversationId,
			lastRunAt: automations.lastRunAt,
			nextRunAt: automations.nextRunAt,
			createdAt: automations.createdAt,
			updatedAt: automations.updatedAt,
			agentId: automations.agentId,
			agentName: agents.name,
			// #66 — a paused agent's automations are skipped, so the card says so.
			agentStatus: agents.status,
			mode: automations.mode,
			outputTarget: automations.outputTarget,
			// #31 — failure state, so the card can distinguish "you turned this off" from
			// "we turned this off because it keeps breaking".
			consecutiveFailures: automations.consecutiveFailures,
			disabledReason: automations.disabledReason,
		})
		.from(automations)
		.leftJoin(agents, eq(agents.id, automations.agentId))
		.where(eq(automations.userId, userId))
		.orderBy(asc(automations.createdAt))

	// #31 — attach the most recent run (and a 24h failure count) in one extra round trip,
	// so the list renders run status without a query per card.
	const summaries = await getLatestRunSummaries(rows.map((row) => row.id))
	return rows.map((row) => {
		const summary = summaries.get(row.id) ?? null
		return {
			...row,
			lastRunStatus: summary?.status ?? null,
			lastRunTrigger: summary?.trigger ?? null,
			lastRunStartedAt: summary?.startedAt ?? null,
			lastRunFinishedAt: summary?.finishedAt ?? null,
			lastRunError: summary?.error ?? null,
			lastRunConversationId: summary?.conversationId ?? null,
			lastRunResearchId: summary?.researchId ?? null,
			failures24h: summary?.failures24h ?? 0,
		}
	})
}

/**
 * #31 — "Run now". Queues a manual `automation_run` job rather than executing inline: a
 * tick can take minutes (an agent loop runs up to 10 rounds) and a remote command must not
 * hold an HTTP request open that long. The worker picks it up within a poll interval.
 *
 * The manual run does NOT touch `next_run_at` (see `runAutomationById`'s `preserveSchedule`)
 * and is allowed on a disabled automation so a fix can be verified before switching it
 * back on.
 */
export async function runAutomationNow(userId: string, automationId: string) {
	const [automation] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
		.limit(1)
	if (!automation) return null

	const { enqueueJob } = await import('$lib/jobs/jobs.server')
	const job = await enqueueJob({
		type: 'automation_run',
		queue: 'default',
		// Above the scheduled tier (50): a human is waiting on this one.
		priority: 150,
		// Collapses a double-click, but a deliberate second run a minute later still works.
		dedupeKey: `automation_manual:${automation.id}:${new Date().toISOString().slice(0, 16)}`,
		payload: { automationId: automation.id, attempt: 1, trigger: 'manual' },
		userId,
	})

	return { jobId: job.id, automationId: automation.id, queuedAt: new Date().toISOString() }
}

export async function createAutomationRecord(input: {
	userId: string
	agentId?: string | null
	description: string
	cronExpression: string
	/** IANA zone the cron expression is read in. Defaults to `DEFAULT_TIMEZONE`. */
	timezone?: string
	prompt: string
	enabled?: boolean
	conversationMode?: 'new_each_run' | 'reuse'
	// Wave 5 #21 phase 4 — execution mode + output routing.
	mode?: 'chat_followup' | 'research' | 'maintenance'
	outputTarget?: 'chat_session' | 'review_inbox'
	// Wave 5 #21 phase 4 finish — code-mode target repository.
	repositoryId?: string | null
}) {
	const now = new Date()
	const timezone = input.timezone ?? DEFAULT_TIMEZONE
	const nextRunAt = scheduleOrReject(input.cronExpression, now, timezone)
	const [created] = await db
		.insert(automations)
		.values({
			userId: input.userId,
			agentId: input.agentId ?? null,
			description: input.description,
			cronExpression: input.cronExpression,
			timezone,
			prompt: input.prompt,
			enabled: input.enabled ?? true,
			conversationMode: input.conversationMode ?? 'new_each_run',
			mode: input.mode ?? 'chat_followup',
			outputTarget: input.outputTarget ?? 'chat_session',
			repositoryId: input.repositoryId ?? null,
			nextRunAt,
			updatedAt: now,
		})
		.returning()

	return created
}

export async function updateAutomationRecord(
	userId: string,
	automationId: string,
	patch: {
		agentId?: string | null
		description?: string
		cronExpression?: string
		timezone?: string
		prompt?: string
		enabled?: boolean
		conversationMode?: 'new_each_run' | 'reuse'
		mode?: 'chat_followup' | 'research' | 'maintenance'
		outputTarget?: 'chat_session' | 'review_inbox'
		repositoryId?: string | null
	},
) {
	const [existing] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
		.limit(1)
	if (!existing) return null

	const updates: Partial<typeof automations.$inferInsert> = {
		updatedAt: new Date(),
	}

	if (patch.agentId !== undefined) updates.agentId = patch.agentId
	if (patch.description !== undefined) updates.description = patch.description
	if (patch.prompt !== undefined) updates.prompt = patch.prompt
	if (patch.enabled !== undefined) {
		updates.enabled = patch.enabled
		// #31 — switching an automation back on is an explicit "I fixed it": clear the
		// failure streak and the disabled-by-failure stamp so it gets a full budget of
		// attempts again, and so the card stops claiming the system disabled it.
		if (patch.enabled) {
			updates.consecutiveFailures = 0
			updates.disabledReason = null
			// A row disabled by the failure policy has a stale `next_run_at` in the past;
			// re-deriving it here means re-enabling actually resumes the schedule.
			if (!existing.enabled && patch.cronExpression === undefined && patch.timezone === undefined) {
				updates.nextRunAt = scheduleOrReject(
					existing.cronExpression,
					new Date(),
					existing.timezone ?? DEFAULT_TIMEZONE,
				)
			}
		} else {
			// A user-initiated disable is not a failure disable — drop the stamp so the two
			// states never blur together.
			updates.disabledReason = null
		}
	}
	if (patch.conversationMode !== undefined) updates.conversationMode = patch.conversationMode
	if (patch.mode !== undefined) updates.mode = patch.mode
	if (patch.outputTarget !== undefined) updates.outputTarget = patch.outputTarget
	if (patch.repositoryId !== undefined) updates.repositoryId = patch.repositoryId
	// The schedule is (expression, zone) — changing either one has to re-derive nextRunAt,
	// and each recompute needs the other half as it will be after this patch lands.
	if (patch.timezone !== undefined) updates.timezone = patch.timezone
	if (patch.cronExpression !== undefined) updates.cronExpression = patch.cronExpression
	if (patch.cronExpression !== undefined || patch.timezone !== undefined) {
		updates.nextRunAt = scheduleOrReject(
			patch.cronExpression ?? existing.cronExpression,
			new Date(),
			patch.timezone ?? existing.timezone ?? DEFAULT_TIMEZONE,
		)
	}

	const [updated] = await db
		.update(automations)
		.set(updates)
		.where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
		.returning()
	return updated
}

/**
 * The next run of a schedule someone just typed. The cron parser's errors name the field and
 * the reason (`Invalid cron hour field "25": value 25 is out of range 0-23`) precisely so the
 * form can show them, which only happens when they travel as a `UserInputError`.
 */
function scheduleOrReject(cronExpression: string, from: Date, timezone: string): Date {
	try {
		return computeNextRunAt(cronExpression, from, timezone)
	} catch (err) {
		throw new UserInputError(err instanceof Error ? err.message : String(err))
	}
}

export async function deleteAutomationRecord(userId: string, automationId: string) {
	await db.delete(automations).where(and(eq(automations.id, automationId), eq(automations.userId, userId)))
	return { success: true as const }
}
