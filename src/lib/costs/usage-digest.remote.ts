import { command, query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { isValidTimeZone } from '$lib/automations/cron'
import {
	enableUsageDigestAutomation,
	findUsageDigestAutomation,
} from '$lib/automations/usage-digest-automation.server'
import { DEFAULT_USAGE_DIGEST_DAYS } from '$lib/costs/usage-digest'
import { computeUsageDigest } from '$lib/costs/usage-digest.server'

/**
 * #38 — the `/activity` usage strip and the weekly digest opt-in.
 *
 * Kept apart from `cost.remote.ts` on purpose: the digest reads the same ledgers but answers
 * a different question ("what happened?", not "what did it cost?"), and cost.remote is where
 * per-run cost attribution is still moving.
 */

const usageDigestSchema = z.object({
	days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
})

export const getUsageDigest = query(usageDigestSchema, async ({ days }) => {
	const user = requireAuthenticatedRequestUser()
	return computeUsageDigest({ userId: user.id, days: days ?? DEFAULT_USAGE_DIGEST_DAYS })
})

/** The owner's weekly digest automation, or null when they have not turned it on. */
export const getUsageDigestAutomation = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return findUsageDigestAutomation(user.id)
})

const enableUsageDigestSchema = z.object({
	outputTarget: z.enum(['review_inbox', 'chat_session']).optional(),
	/** The browser's zone, so "Mondays at 9" means the owner's 9. */
	timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone).optional(),
})

/**
 * Opt in to the weekly digest. Creates the automation or re-enables the existing one; the
 * caller refreshes `getUsageDigestAutomation` and the automations list afterwards.
 */
export const enableUsageDigestCommand = command(enableUsageDigestSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return enableUsageDigestAutomation(user.id, input)
})
