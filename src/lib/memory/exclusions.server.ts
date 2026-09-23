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
	SUPERSEDED_BUILTIN_PATTERNS,
	compileExclusionRule,
	type CompiledExclusionRule,
} from '$lib/memory/exclusions'
import { scanForExclusion, type ExclusionScanMatch } from '$lib/memory/exclusion-scan.server'
import { releaseTimedOutTurns } from '$lib/memory/tombstones.server'
import { logger } from '$lib/observability/logger'

export {
	BUILTIN_EXCLUSION_RULES,
	MAX_PATTERN_LENGTH,
	compileExclusionRule,
	compileExclusionRules,
	describeSavedRuleProblem,
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
 *
 * A built-in row still holding a pattern that has since been replaced (see
 * `SUPERSEDED_BUILTIN_PATTERNS`) is moved to the current one; only that exact old text is
 * matched, so a reworded rule is left alone, and the switch is never touched. Moving one is a
 * change to the rules like any other, so the turns set aside by a timed-out check are released.
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

	let moved = 0
	for (const old of SUPERSEDED_BUILTIN_PATTERNS) {
		const current = BUILTIN_EXCLUSION_RULES.find((rule) => rule.name === old.name)
		if (!current || current.pattern === old.pattern) continue
		const rows = await db
			.update(memoryExclusionRules)
			.set({ pattern: current.pattern, updatedAt: new Date() })
			.where(
				and(
					eq(memoryExclusionRules.userId, userId),
					eq(memoryExclusionRules.builtin, true),
					eq(memoryExclusionRules.name, old.name),
					eq(memoryExclusionRules.pattern, old.pattern),
				),
			)
			.returning({ id: memoryExclusionRules.id })
		moved += rows.length
	}
	if (moved > 0) await exclusionRulesChanged(userId)
}

/**
 * Call after any change to a user's rules — a rule saved, switched, deleted, or a built-in
 * moved to a new pattern. Releases the turns set aside because their check ran out of time
 * (`releaseTimedOutTurns`): the rule that was too slow may be gone or fixed, so they are
 * checked again on their conversation's next pass. Best-effort: the change itself has
 * already been saved, and a failure here only leaves those turns set aside a while longer.
 */
export async function exclusionRulesChanged(userId: string): Promise<void> {
	try {
		const released = await releaseTimedOutTurns(userId)
		if (released > 0) logger.info('[memory] released turns whose exclusion check had timed out', { released })
	} catch (error) {
		logger.warn('[memory] failed to release turns whose exclusion check had timed out', { err: error })
	}
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

export type ExclusionTestResult =
	| { matched: false; busy?: false }
	/** A check of this user's was still running, so this one was not started. */
	| { matched: false; busy: true }
	| { matched: true; ruleName: string; sample: string; timedOut: boolean }

/** Users with a deny-list test under way. */
const testsInFlight = new Set<string>()

/**
 * The deny-list tester: the user's enabled rules against a sample, through the same
 * time-limited scanner the miner uses, so a slow rule cannot freeze the server from here
 * either. One test per user at a time — the tester is a POST anyone signed in can repeat as
 * fast as they like, and each test of a slow rule holds a scanner thread for its full time
 * limit; a second one while the first runs gets `busy` instead of a place in the queue.
 */
export async function testExclusionRules(userId: string, sample: string): Promise<ExclusionTestResult> {
	if (sample.trim().length === 0) return { matched: false }
	if (testsInFlight.has(userId)) return { matched: false, busy: true }
	testsInFlight.add(userId)
	try {
		const match = await scanForExclusion(sample, await loadCompiledExclusionRules(userId))
		if (!match) return { matched: false }
		return { matched: true, ruleName: match.ruleName, sample: match.sample, timedOut: match.timedOut }
	} finally {
		testsInFlight.delete(userId)
	}
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
