import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { stubOpenRouter, type OpenRouterStub } from './openrouter-stub'
import {
	compileBuiltinExclusionRules,
	compileExclusionRules,
	findExclusionMatch,
} from '../src/lib/memory/exclusions'
import { scanForExclusion, scanForExclusions } from '../src/lib/memory/exclusion-scan.server'

/**
 * Exclusion rules are user-written regular expressions, matched against every turn the miner
 * sees, every recall query and the deny-list tester. They used to run on the server's event
 * loop, on the first 40,000 characters only:
 *
 *   - `(a+)+$` against a run of `a`s and a `!` never finishes, so one saved rule froze every
 *     chat, stream and job on the instance — and a mining job that hit it hung the worker
 *     again after every restart;
 *   - a secret past character 40,000 of a long paste was never looked at, and the whole turn
 *     was still sent to the extractor, embedded and stored.
 *
 * Matching now runs on a worker thread with a time limit, over the whole content, and a check
 * that runs out of time counts as a match.
 */

const builtins = compileBuiltinExclusionRules()

test.describe('memory/exclusion-scan — same answers as the reference matcher', () => {
	const samples = [
		'the db password = hunter2trombone',
		'creds are AKIAIOSFODNN7EXAMPLE for the bucket',
		'use sk-or-v1-0123456789abcdefghij when calling it',
		'DATABASE_URL=postgresql://derek:hunter2@192.168.0.2:5432/AgentStudio',
		'-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza',
		'I prefer the aisle seat on long flights.',
		'The password reset email never arrived — support ticket 4412.',
		'https://github.com/derekhearst/AgentStudio/pull/46 is the one to review',
	]

	test('the built-in rules decide every sample the way compileExclusionRule does', async () => {
		const scanned = await scanForExclusions(samples, builtins)
		expect(scanned.map((match) => match?.ruleName ?? null)).toEqual(
			samples.map((sample) => findExclusionMatch(sample, builtins)?.ruleName ?? null),
		)
		expect(scanned.every((match) => !match?.timedOut)).toBe(true)
	})

	test('substring rules are case-insensitive, and the first matching rule wins', async () => {
		const rules = compileExclusionRules([
			{ id: 'a', name: 'Home address', kind: 'substring', pattern: '12 Glebe Point Rd' },
			{ id: 'b', name: 'Also address', kind: 'substring', pattern: 'glebe' },
		])
		const match = await scanForExclusion('Deliver it to 12 GLEBE POINT RD please', rules)
		expect(match).toMatchObject({ ruleId: 'a', ruleName: 'Home address', timedOut: false })
	})

	test('a rule that does not compile never matches', async () => {
		const rules = compileExclusionRules([{ id: 'bad', name: 'Broken', kind: 'regex', pattern: '([unclosed' }])
		expect(await scanForExclusion('anything at all', rules)).toBeNull()
	})

	test('no rules, no worker, no matches', async () => {
		expect(await scanForExclusions(['DATABASE_URL=postgres://u:p@h/db'], [])).toEqual([null])
	})

	test('the sample is redacted, never echoed', async () => {
		const match = await scanForExclusion('use sk-or-v1-0123456789abcdefghij when calling it', builtins)
		expect(match?.sample).not.toContain('abcdefghij')
	})
})

test.describe('memory/exclusion-scan — bounded', () => {
	test('the whole content is scanned: a secret past character 40,000 is caught', async () => {
		const paste = `${'2026-09-23 12:00:00 INFO request served\n'.repeat(1_500)}DATABASE_URL=postgres://app:hunter2@db:5432/app`
		expect(paste.length).toBeGreaterThan(40_000)
		const match = await scanForExclusion(paste, builtins)
		expect(match?.ruleName).toBe('Connection string credentials')
	})

	test('a catastrophic pattern runs out of time, counts as a match, and the server keeps running', async () => {
		const rules = compileExclusionRules([
			{ id: 'slow', name: 'Slow rule', kind: 'regex', pattern: '(a+)+$' },
			{ id: 'sub', name: 'Codename', kind: 'substring', pattern: 'bluebird' },
		])
		// Ticks of the event loop while the scan runs. On the event loop itself the regex would
		// block every one of them until it finished — which it never would.
		let ticks = 0
		const ticker = setInterval(() => (ticks += 1), 10)
		const startedAt = Date.now()
		try {
			const results = await scanForExclusions(
				[`${'a'.repeat(40)}!`, 'nothing to see', 'project bluebird ships friday'],
				rules,
				{ timeoutMs: 300 },
			)
			const elapsed = Date.now() - startedAt

			expect(results[0]).toMatchObject({ ruleId: 'slow', ruleName: 'Slow rule', timedOut: true })
			// A fresh worker takes the next piece: the stuck one does not poison the rest.
			expect(results[1]).toBeNull()
			expect(results[2]).toMatchObject({ ruleName: 'Codename', timedOut: false })
			expect(elapsed, 'bounded by the limit, not by the regex').toBeLessThan(10_000)
			expect(ticks, 'the event loop kept turning while the regex was stuck').toBeGreaterThan(5)
		} finally {
			clearInterval(ticker)
		}
	})
})

test.describe('memory/mining — exclusion scan in the miner', () => {
	// The miner logs its model and embedding usage to the shared cost ledger.
	let releaseBudgetLock: (() => Promise<void>) | null = null
	let stub: OpenRouterStub | null = null
	let startedAt = new Date()
	let prefix = ''
	test.beforeEach(async () => {
		releaseBudgetLock = await acquireGlobalStateLock('budget-state')
		startedAt = new Date()
		prefix = uniquePrefix('mine-exclusion-scan')
	})
	test.afterEach(async () => {
		stub?.restore()
		stub = null
		const sql = getSql()
		await sql`delete from memory_exclusion_rules where name like ${`${prefix}%`}`
		await sql`delete from memory_wings where name like ${`${prefix}%`}`
		await sql`
			delete from llm_usage
			where source in ('memory_extract', 'memory_embed') and created_at >= ${startedAt}
		`
		await releaseBudgetLock?.()
		releaseBudgetLock = null
	})

	/** A token that appears in no other spec's content, so this rule only touches these turns. */
	const token = () => `zq${Math.random().toString(36).slice(2, 10)}`

	test('a secret at the end of a long paste never reaches the extractor, the embeddings or a drawer', async () => {
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const { mineSession } = await import('../src/lib/memory/mining.server')
		const secret = `postgres://app:${token()}@db:5432/app`
		const paste = `${'2026-09-23 12:00:00 INFO request served\n'.repeat(1_500)}DATABASE_URL=${secret}`

		const result = await mineSession({
			userId,
			session: {
				conversationId: null,
				occurredAt: new Date(),
				sessionLabel: `${prefix} chat`,
				turns: [
					{ role: 'user', content: paste },
					{ role: 'user', content: 'Unrelated: the van battery is 48V.' },
				],
			},
		})

		expect(result.excludedTurns).toBe(1)
		expect(result.excludedByRule).toEqual(['Connection string credentials'])
		expect(result.drawerIds).toHaveLength(1)
		for (const call of stub.calls) {
			expect(JSON.stringify(call.body ?? {}), `sent to ${call.path}`).not.toContain(secret)
		}
		const stored = await getSql()<{ n: number }[]>`
			select count(*)::int as n from memory_drawers where content like ${`%${secret}%`}
		`
		expect(stored[0].n).toBe(0)
	})

	test('a slow rule saved before the editor refused it cannot hang the miner; the turn it chokes on is dropped', async () => {
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const marker = token()
		// Straight into the table, as a rule written before save-time validation would be. The
		// marker keeps the slow part from running on any other spec's turns.
		await getSql()`
			insert into memory_exclusion_rules (user_id, name, kind, pattern)
			values (${userId}, ${`${prefix} slow rule`}, 'regex', ${`${marker}(a+)+$`})
		`
		const { mineSession } = await import('../src/lib/memory/mining.server')

		const startedAt = Date.now()
		const result = await mineSession({
			userId,
			session: {
				conversationId: null,
				occurredAt: new Date(),
				sessionLabel: `${prefix} chat`,
				turns: [
					{ role: 'user', content: `${marker}${'a'.repeat(40)}!` },
					{ role: 'user', content: 'The van battery is 48V.' },
				],
			},
		})

		expect(Date.now() - startedAt).toBeLessThan(30_000)
		expect(result.excludedTurns).toBe(1)
		expect(result.excludedByRule).toEqual([`${prefix} slow rule`])
		expect(result.drawerIds).toHaveLength(1)
		const embedded = stub.callsTo('/embeddings').flatMap((call) => (call.body?.input as string[]) ?? [])
		expect(embedded.some((text) => text.includes(marker))).toBe(false)
	})
})
