/**
 * Exclusion rules — DB-backed half.
 *
 * The matching engine and the built-in credential patterns are pure and live in
 * `exclusions.ts`; the time-limited matcher production code uses lives in
 * `exclusion-scan.server.ts`. This module owns seeding, loading, and hit accounting, and
 * re-exports both so callers only need one import.
 */

import { and, eq, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { memoryExclusionRules } from '$lib/memory/memory.schema'
import {
	BUILTIN_EXCLUSION_RULES,
	compileExclusionRule,
	type CompiledExclusionRule,
} from '$lib/memory/exclusions'
import { scanForExclusion, type ExclusionScanMatch } from '$lib/memory/exclusion-scan.server'
import { logger } from '$lib/observability/logger'

export {
	BUILTIN_EXCLUSION_RULES,
	MAX_PATTERN_LENGTH,
	compileExclusionRule,
	compileExclusionRules,
	redactSample,
	validateExclusionPattern,
} from '$lib/memory/exclusions'
export type {
	BuiltinExclusionRule,
	CompiledExclusionRule,
	ExclusionKind,
	ExclusionMatch,
} from '$lib/memory/exclusions'
export {
	EXCLUSION_SCAN_TIMEOUT_MS,
	scanForExclusion,
	scanForExclusions,
	type ExclusionScanMatch,
} from '$lib/memory/exclusion-scan.server'

/**
 * Seed the credential rules for a user. Idempotent: conflicts on (user_id, name) are
 * ignored, so a user who disabled or reworded a built-in keeps their version.
 */
export async function ensureBuiltinExclusionRules(userId: string): Promise<void> {
	await db
		.insert(memoryExclusionRules)
		.values(
			BUILTIN_EXCLUSION_RULES.map((rule) => ({
				userId,
				name: rule.name,
				description: rule.description,
				kind: rule.kind,
				pattern: rule.pattern,
				enabled: true,
				builtin: true,
			})),
		)
		.onConflictDoNothing({ target: [memoryExclusionRules.userId, memoryExclusionRules.name] })
}

/** Load every enabled rule for a user, compiled and ready to match. */
export async function loadCompiledExclusionRules(userId: string): Promise<CompiledExclusionRule[]> {
	const rows = await db
		.select({
			id: memoryExclusionRules.id,
			name: memoryExclusionRules.name,
			kind: memoryExclusionRules.kind,
			pattern: memoryExclusionRules.pattern,
		})
		.from(memoryExclusionRules)
		.where(and(eq(memoryExclusionRules.userId, userId), eq(memoryExclusionRules.enabled, true)))

	const compiled = rows.map((row) => compileExclusionRule(row))
	for (const rule of compiled) {
		if (rule.invalid) {
			logger.warn('[memory] exclusion rule has an unusable pattern and will never match', { rule: rule.name })
		}
	}
	return compiled
}

/**
 * The rule `content` matches, if any, among the user's enabled rules — for text that is about
 * to leave the process somewhere other than the miner, which checks its turns itself. Recall
 * uses it on the user's message before that message is embedded or written to the recall log.
 *
 * A user who has never mined has never had the built-ins seeded, and would otherwise be
 * checked against nothing; they are seeded when no enabled rule is found. Throws when the
 * rules cannot be loaded, so a caller fails closed rather than sending the text unchecked.
 */
export async function matchExclusionRules(userId: string, content: string): Promise<ExclusionScanMatch | null> {
	let rules = await loadCompiledExclusionRules(userId)
	if (rules.length === 0) {
		await ensureBuiltinExclusionRules(userId)
		rules = await loadCompiledExclusionRules(userId)
	}
	return scanForExclusion(content, rules)
}

/**
 * Bump hit counters after a mine pass so the rules list shows what is actually firing.
 * Accepts the raw (possibly repeated) list of rule ids that matched.
 */
export async function recordExclusionHits(ruleIds: Array<string | null>): Promise<void> {
	const counts = new Map<string, number>()
	for (const id of ruleIds) {
		if (!id) continue
		counts.set(id, (counts.get(id) ?? 0) + 1)
	}
	if (counts.size === 0) return
	try {
		const now = new Date()
		for (const [id, n] of counts) {
			await db
				.update(memoryExclusionRules)
				.set({ hitCount: sql`${memoryExclusionRules.hitCount} + ${n}`, lastHitAt: now })
				.where(eq(memoryExclusionRules.id, id))
		}
	} catch (error) {
		logger.warn('[memory] failed to record exclusion hits', { err: error })
	}
}
