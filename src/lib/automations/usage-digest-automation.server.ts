import { and, asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { createAutomationRecord, updateAutomationRecord } from '$lib/automations/automation.server'
import { DEFAULT_TIMEZONE } from '$lib/automations/cron'
import { USAGE_DIGEST_CRON, USAGE_DIGEST_PROMPT, parseUsageDigestPrompt } from '$lib/costs/usage-digest'

/**
 * #38 — the weekly usage digest is an ordinary maintenance automation whose prompt is the
 * `{{usage_digest}}` placeholder (see `maintenance-mode.server.ts`). No new scheduler, no
 * new table: the existing dispatch tick runs it, the run ledger records it, and output
 * routing delivers it.
 *
 * Nothing creates one at boot. Bootstrap runs before `/setup` has created the owner, and a
 * seeded row would come back after the owner deleted it — so a deploy never starts posting
 * digests on its own. The owner opts in from `/activity`, which lands here.
 */

export const USAGE_DIGEST_DESCRIPTION = 'Weekly usage digest'

export type UsageDigestAutomation = {
	id: string
	description: string
	enabled: boolean
	outputTarget: 'chat_session' | 'review_inbox'
	cronExpression: string
	timezone: string
	nextRunAt: Date | null
	days: number
}

/**
 * The owner's digest automation, if there is one. Recognised by its prompt rather than a
 * flag, so one written by hand on `/automations` counts too. An enabled one wins over a
 * disabled one; otherwise the oldest.
 */
export async function findUsageDigestAutomation(userId: string): Promise<UsageDigestAutomation | null> {
	const rows = await db
		.select()
		.from(automations)
		.where(and(eq(automations.userId, userId), eq(automations.mode, 'maintenance')))
		.orderBy(asc(automations.createdAt))

	const digests = rows.flatMap((row) => {
		const days = parseUsageDigestPrompt(row.prompt)
		if (days === null) return []
		return [
			{
				id: row.id,
				description: row.description,
				enabled: row.enabled,
				outputTarget: row.outputTarget,
				cronExpression: row.cronExpression,
				timezone: row.timezone,
				nextRunAt: row.nextRunAt,
				days,
			},
		]
	})
	return digests.find((digest) => digest.enabled) ?? digests[0] ?? null
}

/**
 * Turn the weekly digest on: re-enable the existing one (optionally re-targeting it), or
 * create it. Idempotent, so a double-click cannot make two.
 */
export async function enableUsageDigestAutomation(
	userId: string,
	options: { outputTarget?: 'chat_session' | 'review_inbox'; timezone?: string } = {},
): Promise<UsageDigestAutomation> {
	const existing = await findUsageDigestAutomation(userId)
	if (existing) {
		const retarget = options.outputTarget !== undefined && options.outputTarget !== existing.outputTarget
		if (!existing.enabled || retarget) {
			await updateAutomationRecord(userId, existing.id, {
				enabled: true,
				...(retarget ? { outputTarget: options.outputTarget } : {}),
			})
		}
	} else {
		await createAutomationRecord({
			userId,
			description: USAGE_DIGEST_DESCRIPTION,
			cronExpression: USAGE_DIGEST_CRON,
			timezone: options.timezone ?? DEFAULT_TIMEZONE,
			prompt: USAGE_DIGEST_PROMPT,
			enabled: true,
			// One thread that collects every week's digest, rather than a new chat each Monday.
			conversationMode: 'reuse',
			mode: 'maintenance',
			outputTarget: options.outputTarget ?? 'review_inbox',
		})
	}

	const current = await findUsageDigestAutomation(userId)
	if (!current) throw new Error('The usage digest automation could not be saved')
	return current
}
