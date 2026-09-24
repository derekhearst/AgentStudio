import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { stubOpenRouter, type OpenRouterStub } from './openrouter-stub'
import {
	BUILTIN_EXCLUSION_RULES,
	SUPERSEDED_BUILTIN_PATTERNS,
	compileBuiltinExclusionRules,
	compileExclusionRules,
	findExclusionMatch,
} from '../src/lib/memory/exclusions'
import {
	EXCLUSION_SCAN_CONCURRENCY,
	exclusionScanLoad,
	scanForExclusion,
	scanForExclusions,
} from '../src/lib/memory/exclusion-scan.server'

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
 * that runs out of time counts as a match. The threads are a pool capped for the process: one
 * thread per check let a burst of tester requests against `(a|aa)+$` start hundreds at once.
 */

const builtins = compileBuiltinExclusionRules()

/**
 * Held by specs that change the active user's rules, or depend on them not changing: a change
 * releases every turn set aside by a timed-out check (`exclusionRulesChanged`). The palace UI
 * spec that saves a rule takes it too.
 */
const RULE_CHANGES_LOCK = 'memory-exclusion-rule-changes'

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

	test('long dotted and dashed runs get an answer, not a timeout, from the built-in rules', async () => {
		// Two built-ins read to the end of a run from every place in it they could start, which
		// is quadratic: 120,000 characters of `a.` took over a second, so the whole turn counted
		// as a credential and was dropped for good.
		for (const text of ['a.'.repeat(60_000), 'a-'.repeat(60_000), 'eyJ-'.repeat(30_000)]) {
			const startedAt = Date.now()
			expect(await scanForExclusion(text, builtins), text.slice(0, 8)).toBeNull()
			expect(Date.now() - startedAt, text.slice(0, 8)).toBeLessThan(500)
		}
	})
})

test.describe('memory/exclusion-scan — a capped pool of threads', () => {
	const slow = compileExclusionRules([{ id: 'slow', name: 'Slow rule', kind: 'regex', pattern: '(a|aa)+$' }])
	const codename = compileExclusionRules([{ id: 'sub', name: 'Codename', kind: 'substring', pattern: 'bluebird' }])

	test('a burst of slow checks never runs more than the cap at once, and each gets its whole time limit', async () => {
		// `(a|aa)+$` gets past the editor's check, and every check used to start a thread of its
		// own: 200 at once took a server from 22 MB to 1.78 GB with every core busy.
		const timeoutMs = 200
		const rounds = 3
		const burst = EXCLUSION_SCAN_CONCURRENCY * rounds
		const peak = { scanning: 0, threads: 0 }
		const sample = () => {
			const load = exclusionScanLoad()
			peak.scanning = Math.max(peak.scanning, load.scanning)
			peak.threads = Math.max(peak.threads, load.threads)
			return load
		}
		const sampler = setInterval(sample, 1)
		const startedAt = Date.now()
		try {
			const slowChecks = Array.from({ length: burst }, () =>
				scanForExclusion(`${'a'.repeat(60)}!`, slow, { timeoutMs }),
			)
			// Last in line: it waits through every round of the burst before it has a thread.
			const quick = scanForExclusion('project bluebird ships friday', codename, { timeoutMs })

			const queued = sample()
			expect(queued.scanning).toBe(EXCLUSION_SCAN_CONCURRENCY)
			expect(queued.waiting, 'the rest wait their turn').toBe(burst + 1 - EXCLUSION_SCAN_CONCURRENCY)

			const results = await Promise.all(slowChecks)
			const quickResult = await quick
			const elapsed = Date.now() - startedAt

			expect(results.every((result) => result?.timedOut === true)).toBe(true)
			// Its limit started when it got a thread, not when it joined the queue — or waiting
			// through the burst would have used it up.
			expect(quickResult).toMatchObject({ ruleName: 'Codename', timedOut: false })
			expect(peak.scanning).toBeLessThanOrEqual(EXCLUSION_SCAN_CONCURRENCY)
			expect(peak.threads).toBeLessThanOrEqual(EXCLUSION_SCAN_CONCURRENCY)
			expect(elapsed, 'one round per cap-full of checks, not all at once').toBeGreaterThanOrEqual(
				rounds * timeoutMs * 0.9,
			)
			expect(exclusionScanLoad()).toMatchObject({ scanning: 0, waiting: 0 })
		} finally {
			clearInterval(sampler)
		}
	})

	test('a thread that answered in time is kept for the next check, not replaced', async () => {
		const before = exclusionScanLoad().threads
		for (let i = 0; i < 20; i += 1) {
			expect(await scanForExclusion('nothing to see here', builtins)).toBeNull()
		}
		expect(exclusionScanLoad().threads).toBeLessThanOrEqual(Math.max(before, 1))
	})
})

test.describe('memory/exclusion-scan — the deny-list tester', () => {
	test('one test per user at a time: another sent meanwhile is turned away, not queued', async () => {
		// Each test of a slow rule holds a thread for its whole limit, and the tester is a POST
		// that can be repeated as fast as a script can send it.
		const userId = await getActiveUserId()
		const { testExclusionRules } = await import('../src/lib/memory/exclusions.server')

		const [first, second] = await Promise.all([
			testExclusionRules(userId, 'DATABASE_URL=postgres://app:hunter2@db:5432/app'),
			testExclusionRules(userId, 'the van battery is 48V'),
		])
		expect(first).not.toHaveProperty('busy', true)
		expect(second).toEqual({ matched: false, busy: true })
		// Once the first is answered the next is served.
		expect(await testExclusionRules(userId, 'the van battery is 48V')).not.toHaveProperty('busy', true)
	})
})

test.describe('memory/exclusions — built-in patterns that were replaced', () => {
	test('a seeded row still holding the old text is moved to the new one; a reworded row is left alone', async () => {
		// Seeding never overwrites a row, so without this every palace seeded before the fix
		// kept the quadratic pattern.
		const release = await acquireGlobalStateLock(RULE_CHANGES_LOCK)
		const userId = await getActiveUserId()
		const { ensureBuiltinExclusionRules } = await import('../src/lib/memory/exclusions.server')
		const sql = getSql()
		const name = 'Connection string credentials'
		const current = BUILTIN_EXCLUSION_RULES.find((rule) => rule.name === name)!.pattern
		const old = SUPERSEDED_BUILTIN_PATTERNS.find((rule) => rule.name === name)!.pattern
		const patternNow = async () => {
			const [row] = await sql<{ pattern: string }[]>`
				select pattern from memory_exclusion_rules where user_id = ${userId} and name = ${name}
			`
			return row.pattern
		}
		await ensureBuiltinExclusionRules(userId)
		const [original] = await sql<{ pattern: string; builtin: boolean }[]>`
			select pattern, builtin from memory_exclusion_rules where user_id = ${userId} and name = ${name}
		`
		try {
			await sql`
				update memory_exclusion_rules set pattern = ${old}, builtin = true
				where user_id = ${userId} and name = ${name}
			`
			await ensureBuiltinExclusionRules(userId)
			expect(await patternNow()).toBe(current)

			// Still a working rule, so a spec mining in parallel loses nothing meanwhile.
			const reworded = `${current}(?:)`
			await sql`update memory_exclusion_rules set pattern = ${reworded} where user_id = ${userId} and name = ${name}`
			await ensureBuiltinExclusionRules(userId)
			expect(await patternNow()).toBe(reworded)
		} finally {
			await sql`
				update memory_exclusion_rules set pattern = ${original.pattern}, builtin = ${original.builtin}
				where user_id = ${userId} and name = ${name}
			`
			await release()
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
		expect(result.timedOutTurns, 'dropped because the check ran out of time').toBe(1)
		expect(result.excludedByRule).toEqual([`${prefix} slow rule`])
		expect(result.drawerIds).toHaveLength(1)
		const embedded = stub.callsTo('/embeddings').flatMap((call) => (call.body?.input as string[]) ?? [])
		expect(embedded.some((text) => text.includes(marker))).toBe(false)
	})

	test('a turn whose check runs out of time is only set aside: no hit, and a change to the rules lets it back', async () => {
		// A timed-out check was tombstoned as `excluded_by_rule` and counted as a hit, so a
		// harmless paste a slow rule choked on was out of memory for good — under a rule it never
		// matched, and even after the rule was fixed.
		const releaseRuleChanges = await acquireGlobalStateLock(RULE_CHANGES_LOCK)
		stub = stubOpenRouter()
		const userId = await getActiveUserId()
		const marker = token()
		const sql = getSql()
		const [rule] = await sql<{ id: string }[]>`
			insert into memory_exclusion_rules (user_id, name, kind, pattern)
			values (${userId}, ${`${prefix} slow rule`}, 'regex', ${`${marker}(a+)+$`})
			returning id
		`
		const [conversation] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} chat`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
			returning id
		`
		const [message] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, role, content, sequence)
			values (${conversation.id}, 'user'::message_role, ${`${marker}${'a'.repeat(40)}!`}, 1)
			returning id
		`
		const tombstoneOf = async () =>
			(await sql<{ reason: string }[]>`select reason from memory_message_tombstones where message_id = ${message.id}`)[0]
				?.reason ?? null
		const hitsOf = async () =>
			(await sql<{ hit_count: number }[]>`select hit_count from memory_exclusion_rules where id = ${rule.id}`)[0].hit_count
		try {
			const { mineConversation } = await import('../src/lib/memory/memory.server')
			const { exclusionRulesChanged } = await import('../src/lib/memory/exclusions.server')

			const first = await mineConversation({ conversationId: conversation.id })
			expect(first).toMatchObject({ excludedTurns: 1, timedOutTurns: 1, drawerIds: [] })
			expect(await tombstoneOf(), 'set aside, not excluded').toBe('exclusion_timed_out')
			expect(await hitsOf(), 'the rule never matched, so it is not a hit').toBe(0)

			// Reworded so it answers in time. Saving it releases the turn for another look.
			await sql`update memory_exclusion_rules set pattern = ${`${marker}a+!`} where id = ${rule.id}`
			await exclusionRulesChanged(userId)
			expect(await tombstoneOf()).toBeNull()

			const second = await mineConversation({ conversationId: conversation.id })
			expect(second).toMatchObject({ excludedTurns: 1, timedOutTurns: 0 })
			// Now it really matched: excluded for good, and counted.
			expect(await tombstoneOf()).toBe('excluded_by_rule')
			expect(await hitsOf()).toBe(1)
			// Only this turn's calls: the stub sees every OpenRouter request in the worker, and the
			// in-process job worker can run another spec's job (an evaluator call) meanwhile.
			expect(
				stub.calls.filter((call) => JSON.stringify(call.body ?? {}).includes(marker)),
				'nothing reached the extractor or the embeddings',
			).toHaveLength(0)
		} finally {
			// Its messages and their tombstones go with it.
			await sql`delete from conversations where id = ${conversation.id}`
			await releaseRuleChanges()
		}
	})

	test('when the rules cannot be loaded, the pass fails and nothing is sent anywhere', async () => {
		// It used to log "mining without a deny list" and carry on: one dropped connection and
		// every turn, secrets included, went to the extractor and the embeddings and was stored.
		// Recall already failed closed on the same error. An id that is not a uuid makes every
		// query on the rules table fail, as it would with the database unreachable.
		stub = stubOpenRouter()
		const { mineSession } = await import('../src/lib/memory/mining.server')

		await expect(
			mineSession({
				userId: 'not-a-user-id',
				session: {
					conversationId: null,
					occurredAt: new Date(),
					sessionLabel: `${prefix} chat`,
					turns: [{ role: 'user', content: 'DATABASE_URL=postgres://app:hunter2@db:5432/app' }],
				},
			}),
		).rejects.toThrow()
		// Only calls carrying this turn (see above: other jobs can reach the stub meanwhile).
		expect(
			stub.calls.filter((call) => JSON.stringify(call.body ?? {}).includes('hunter2')),
			'nothing reached the extractor or the embeddings',
		).toHaveLength(0)
	})
})
