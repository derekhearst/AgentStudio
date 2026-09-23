import { eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations, type AutomationRow } from '$lib/automations/automation.schema'
import { logger } from '$lib/observability/logger'
import {
	AUTOMATION_DISABLE_AFTER_FAILURES,
	AUTOMATION_MAX_ATTEMPTS,
	automationFailureDedupeKey,
	shouldDisableAfterFailures,
} from './failure-policy'

/**
 * #31 — what a *terminally* failed tick does, once retries are exhausted.
 *
 * Three things, in this order:
 *   1. bump the consecutive-failure counter (one tick = one failure, retries included);
 *   2. switch the automation off when the counter crosses the threshold, stamping
 *      `disabledReason` so the UI can tell "the system gave up on this" apart from
 *      "the user turned it off";
 *   3. surface it — a review item (deduped per failure streak) plus an in-app
 *      notification, because the whole point of the issue is that a broken automation
 *      used to be silent until someone noticed the output never arrived.
 *
 * Every side effect is individually try/caught. A failing automation is already a bad day;
 * a throw out of the reporting path would also lose the retry/disable bookkeeping.
 */

export type AutomationFailureOutcome = {
	consecutiveFailures: number
	disabled: boolean
	reviewItemId: string | null
}

export async function recordTerminalAutomationFailure(args: {
	automation: Pick<AutomationRow, 'id' | 'userId' | 'description' | 'mode' | 'enabled'>
	error: unknown
	attempts: number
	jobId?: string | null
	now?: Date
	/**
	 * Roll `nextRunAt` forward past the tick that gave up. True for a scheduled tick; false for
	 * a run the schedule did not start (a monitor firing), which must not move it.
	 */
	advanceSchedule?: boolean
}): Promise<AutomationFailureOutcome> {
	const { automation, attempts } = args
	const now = args.now ?? new Date()
	const message = args.error instanceof Error ? args.error.message : String(args.error ?? 'Unknown error')

	const consecutiveFailures = await bumpConsecutiveFailures(automation.id)
	const disabled = automation.enabled && shouldDisableAfterFailures(consecutiveFailures)

	// A failed tick never advanced the schedule, so `next_run_at` is still in the past and
	// the dispatcher would keep colliding with the same dedupe key — the automation would
	// be wedged even after the underlying problem is fixed. Roll the schedule forward to
	// the next slot: we are giving up on THIS tick, not on the automation.
	if (args.advanceSchedule ?? true) await advanceScheduleAfterGivingUp(args.automation.id, now)

	if (disabled) {
		try {
			await db
				.update(automations)
				.set({ enabled: false, disabledReason: 'consecutive_failures', updatedAt: now })
				.where(eq(automations.id, automation.id))
		} catch (err) {
			logger.warn('[automations] disable-after-failures update failed', { err })
		}
	}

	logger.warn('[automations] tick failed permanently', {
		automationId: automation.id,
		attempts,
		consecutiveFailures,
		disabled,
		error: message,
	})

	const reviewItemId = await openFailureReviewItem({
		automation,
		message,
		attempts,
		consecutiveFailures,
		disabled,
		jobId: args.jobId ?? null,
	})

	await fireFailureNotification({ automation, message, disabled, consecutiveFailures })

	void recordFailureMetric(automation.mode, disabled)

	return { consecutiveFailures, disabled, reviewItemId }
}

async function advanceScheduleAfterGivingUp(automationId: string, now: Date): Promise<void> {
	try {
		const [row] = await db
			.select({ cronExpression: automations.cronExpression, timezone: automations.timezone })
			.from(automations)
			.where(eq(automations.id, automationId))
			.limit(1)
		if (!row) return
		const { computeNextRunAt } = await import('./cron')
		const nextRunAt = computeNextRunAt(row.cronExpression, now, row.timezone)
		await db
			.update(automations)
			.set({ lastRunAt: now, nextRunAt, updatedAt: now })
			.where(eq(automations.id, automationId))
	} catch (err) {
		// A bad cron expression is itself a plausible reason the tick failed. Leave the
		// schedule alone rather than writing garbage; the review item still names the row.
		logger.warn('[automations] could not advance schedule after failure', { err })
	}
}

/** Atomic increment so two workers failing the same automation can't clobber each other. */
async function bumpConsecutiveFailures(automationId: string): Promise<number> {
	try {
		const [row] = await db
			.update(automations)
			.set({
				consecutiveFailures: drizzleSql`${automations.consecutiveFailures} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(automations.id, automationId))
			.returning({ consecutiveFailures: automations.consecutiveFailures })
		return row?.consecutiveFailures ?? 1
	} catch (err) {
		logger.warn('[automations] consecutive-failure increment failed', { err })
		return 1
	}
}

/**
 * Opens a `job_failure` review item. We reuse the existing type rather than adding an enum
 * value: an automation tick IS a job in this system, the payload's `kind` discriminates
 * automation failures from generic ones, and extending a pg enum in the same migration
 * that uses it is exactly the kind of thing that takes a boot-time migration down.
 */
async function openFailureReviewItem(args: {
	automation: Pick<AutomationRow, 'id' | 'userId' | 'description' | 'mode'>
	message: string
	attempts: number
	consecutiveFailures: number
	disabled: boolean
	jobId: string | null
}): Promise<string | null> {
	try {
		const { openReviewItem } = await import('$lib/observability/review.server')
		const item = await openReviewItem({
			type: 'job_failure',
			severity: args.disabled ? 'critical' : 'warning',
			summary: args.disabled
				? `Automation disabled after ${args.consecutiveFailures} failures: ${args.automation.description.slice(0, 80)}`
				: `Automation failed (${args.attempts}/${AUTOMATION_MAX_ATTEMPTS} attempts): ${args.automation.description.slice(0, 80)}`,
			payload: {
				kind: 'automation_failure',
				automationId: args.automation.id,
				automationDescription: args.automation.description,
				mode: args.automation.mode,
				userId: args.automation.userId,
				attempts: args.attempts,
				maxAttempts: AUTOMATION_MAX_ATTEMPTS,
				consecutiveFailures: args.consecutiveFailures,
				disabled: args.disabled,
				disableThreshold: AUTOMATION_DISABLE_AFTER_FAILURES,
				error: args.message.slice(0, 2000),
			},
			jobId: args.jobId,
			// Keyed on the streak, so a loop folds into one open row per streak instead of
			// one per tick. A successful run resets the streak and the next break opens fresh.
			dedupeKey: automationFailureDedupeKey(args.automation.id, args.consecutiveFailures),
		})
		return item?.id ?? null
	} catch (err) {
		logger.warn('[automations] failure review item open failed', { err })
		return null
	}
}

/**
 * In-app notification row + web push when VAPID is configured. Mirrors the research
 * completion notification so failures land in the same place users already look.
 */
async function fireFailureNotification(args: {
	automation: Pick<AutomationRow, 'id' | 'userId' | 'description'>
	message: string
	disabled: boolean
	consecutiveFailures: number
}): Promise<void> {
	const description =
		args.automation.description.length > 90
			? `${args.automation.description.slice(0, 87)}…`
			: args.automation.description
	const payload = {
		title: args.disabled ? 'Automation disabled after repeated failures' : 'Automation run failed',
		body: `${description} — ${args.message.slice(0, 140)}`,
		url: '/automations',
		tag: `automation-failure:${args.automation.id}`,
	}

	try {
		const { createNotificationRecord } = await import('$lib/notifications/notifications.server')
		await createNotificationRecord(payload, args.automation.userId)
	} catch (err) {
		logger.warn('[automations] failure notification record failed', { err })
	}

	try {
		const { sendPushToAll } = await import('$lib/notifications/notifications.server')
		await sendPushToAll(payload, args.automation.userId)
	} catch {
		// No VAPID keys in local/dev, or every subscription is stale. The in-app row is
		// already written, which is the part we actually rely on.
	}
}

async function recordFailureMetric(mode: string, disabled: boolean): Promise<void> {
	try {
		const { recordMetric } = await import('$lib/observability/metrics.server')
		await recordMetric({
			metric: 'automations.lifecycle.gave_up',
			dimension: { mode, disabled: disabled ? 'true' : 'false' },
			value: 1,
		})
	} catch (err) {
		logger.warn('[automations] gave_up metric failed (non-fatal)', { err })
	}
}
