/**
 * Exclusion rules — matching with a time limit, off the event loop.
 *
 * A rule's pattern is a JavaScript regular expression a user wrote, and those backtrack:
 * `(a+)+$` against a run of `a`s takes exponential time, and plenty of innocent-looking
 * patterns take quadratic time on a long paste. Run on the web server's event loop, one such
 * check froze every chat, stream and job on the instance — and a mining job that hit it hung
 * the worker, was reclaimed after a restart, and hung it again. The rule editor now refuses
 * the classic shape (`findNestedQuantifier`), but no structural check recognises every slow
 * pattern, and rules saved before it existed are still live.
 *
 * So every check runs here: on a worker thread, with a time limit per piece of content. When
 * the limit passes, the worker is terminated — which interrupts a regex mid-backtrack — and
 * the content counts as matched by the rule that was running. Dropping one turn is the failure
 * a deny list can afford; storing a secret is not.
 *
 * The threads are a small pool, capped for the whole process (`EXCLUSION_SCAN_CONCURRENCY`).
 * Starting one per check let a burst of checks — the deny-list tester is one POST away, and
 * `(a|aa)+$` gets past the editor — start hundreds of threads at once, each spinning a core
 * for its full second: 200 of them took the server from 22 MB to 1.78 GB. A check now waits for
 * a free thread, and its time limit starts only once it has one, so waiting in line never
 * counts against it. A thread that answered in time stays warm for the next check, which also
 * spares each chat turn the cost of starting one.
 *
 * Because the check is bounded in time it is not bounded in length: the whole content is
 * scanned. It used to stop at 40,000 characters while the rest of the turn was still sent to
 * the extractor, embedded and stored, so a secret near the end of a long paste got through.
 *
 * The rules are applied exactly as `compileExclusionRule` in `./exclusions` applies them —
 * case-insensitive, no `g` flag, substrings by lower-cased `indexOf`, first rule in list
 * order wins — and the specs hold the two to the same cases.
 */

import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { redactSample, type CompiledExclusionRule, type ExclusionMatch } from '$lib/memory/exclusions'
import { logger } from '$lib/observability/logger'

/** How long one piece of content may take against the whole rule set before it counts as matched. */
export const EXCLUSION_SCAN_TIMEOUT_MS = 1_000

/**
 * How many scanner threads may exist at once in this process — checking, or idle and warm.
 * One core is left for the event loop; two is the floor so one slow check does not hold up
 * every chat turn behind it.
 */
export const EXCLUSION_SCAN_CONCURRENCY = Math.min(4, Math.max(2, availableParallelism() - 1))

/** A warm thread nobody has used for this long is let go. */
const IDLE_THREAD_MS = 60_000

/** A thread that has not said it is ready by then is given up on (its slot must not be lost). */
const START_TIMEOUT_MS = 10_000

/** How long a terminated thread is waited for before its slot is handed on regardless. */
const TERMINATE_WAIT_MS = 5_000

export type ExclusionScanMatch = ExclusionMatch & {
	/** The rule gave no answer in time, so the content is treated as matching it. */
	timedOut: boolean
}

export type ExclusionScanOptions = {
	/** Per piece of content. Specs lower it; production uses `EXCLUSION_SCAN_TIMEOUT_MS`. */
	timeoutMs?: number
}

/**
 * The worker's source. Plain CommonJS evaluated from a string (`eval: true`), so there is no
 * file of its own for the bundler to find. It says when it is ready, then answers one message
 * per piece of content — compiling the rule set it is sent when it differs from the last one,
 * and announcing each rule before running it, so that when the time runs out the caller knows
 * which rule was still running.
 */
const SCANNER_SOURCE = `
const { parentPort } = require('node:worker_threads')
function compile(rules) {
	return rules.map((rule) => {
		if (rule.kind === 'substring') {
			const needle = rule.pattern.trim().toLowerCase()
			return (text) => {
				if (needle.length === 0) return null
				const at = text.toLowerCase().indexOf(needle)
				return at === -1 ? null : text.slice(at, at + needle.length)
			}
		}
		let re = null
		try {
			re = new RegExp(rule.pattern.trim(), 'i')
		} catch {
			re = null
		}
		return (text) => {
			if (!re) return null
			const match = re.exec(text)
			return match ? match[0] : null
		}
	})
}
let compiledKey = null
let matchers = []
parentPort.on('message', ({ id, key, rules, content }) => {
	if (key !== compiledKey) {
		matchers = compile(rules)
		compiledKey = key
	}
	for (let index = 0; index < matchers.length; index += 1) {
		parentPort.postMessage({ type: 'testing', id, index })
		const hit = matchers[index](content)
		if (hit !== null) {
			parentPort.postMessage({ type: 'verdict', id, index, hit })
			return
		}
	}
	parentPort.postMessage({ type: 'verdict', id, index: -1, hit: null })
})
parentPort.postMessage({ type: 'ready' })
`

type ScannerMessage =
	| { type: 'ready' }
	| { type: 'testing'; id: number; index: number }
	| { type: 'verdict'; id: number; index: number; hit: string | null }

type Verdict = { index: number; hit: string | null } | { index: number; timedOut: true }

type Scanner = {
	worker: Worker
	alive: boolean
	idleTimer: ReturnType<typeof setTimeout> | null
}

type RuleSet = { key: string; rules: Array<{ kind: string; pattern: string }> }

/* ------------------------------------------------------------------ the pool */

/** Slots taken: checks under way, each holding one thread. At most `EXCLUSION_SCAN_CONCURRENCY`. */
let slotsTaken = 0
/** Checks waiting for a slot, first come first served. */
const waiting: Array<() => void> = []
/** Warm threads with nothing to do. A slot holder takes one before starting a new thread. */
const idle: Scanner[] = []
/** Threads started and not yet exited. Never more than the cap: see `withScanner`. */
let threads = 0
let nextScanId = 1

function takeSlot(): Promise<void> {
	if (slotsTaken < EXCLUSION_SCAN_CONCURRENCY) {
		slotsTaken += 1
		return Promise.resolve()
	}
	return new Promise((resolve) => waiting.push(resolve))
}

function releaseSlot() {
	const next = waiting.shift()
	// Handed straight to the next in line, so a newcomer cannot slip in ahead of it.
	if (next) next()
	else slotsTaken -= 1
}

/** A thread, once it has said it is ready. */
function startScanner(): Promise<Scanner> {
	const worker = new Worker(SCANNER_SOURCE, { eval: true })
	const scanner: Scanner = { worker, alive: true, idleTimer: null }
	threads += 1
	// A check in flight is kept alive by its timer; an idle thread must not hold the process open.
	worker.unref()
	// A worker 'error' with no listener is rethrown on this thread, and would take the server
	// down. Each check listens for the errors that concern it; this catches the rest.
	worker.on('error', () => undefined)
	worker.once('exit', () => markExited(scanner))
	return new Promise((resolve, reject) => {
		const settle = () => {
			clearTimeout(timer)
			worker.off('message', onMessage)
			worker.off('error', onError)
			worker.off('exit', onExit)
		}
		const fail = (error: Error) => {
			settle()
			void worker.terminate()
			reject(error)
		}
		const onMessage = (message: ScannerMessage) => {
			if (message.type !== 'ready') return
			settle()
			resolve(scanner)
		}
		const onError = (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
		const onExit = (code: number) => fail(new Error(`the exclusion scanner exited before it was ready (code ${code})`))
		const timer = setTimeout(
			() => fail(new Error(`the exclusion scanner was not ready within ${START_TIMEOUT_MS} ms`)),
			START_TIMEOUT_MS,
		)
		worker.on('message', onMessage)
		worker.on('error', onError)
		worker.on('exit', onExit)
	})
}

function markExited(scanner: Scanner) {
	if (!scanner.alive) return
	scanner.alive = false
	threads -= 1
	if (scanner.idleTimer) clearTimeout(scanner.idleTimer)
	const at = idle.indexOf(scanner)
	if (at !== -1) idle.splice(at, 1)
}

/** Back to the idle list, to be let go if nothing needs it for a while. */
function park(scanner: Scanner) {
	if (!scanner.alive) return
	const timer = setTimeout(() => {
		const at = idle.indexOf(scanner)
		if (at === -1) return
		idle.splice(at, 1)
		void scanner.worker.terminate()
	}, IDLE_THREAD_MS)
	// Nor must the timer that lets it go.
	;(timer as { unref?: () => void }).unref?.()
	scanner.idleTimer = timer
	idle.push(scanner)
}

/**
 * Terminate a thread and wait for it to go, so the slot it frees is not filled by a new
 * thread while the old one is still spinning. Bounded, so a thread that will not die cannot
 * take its slot with it.
 */
async function retire(scanner: Scanner) {
	if (!scanner.alive) return
	let waited: ReturnType<typeof setTimeout> | undefined
	const gaveUp = new Promise<'gave-up'>((resolve) => {
		waited = setTimeout(() => resolve('gave-up'), TERMINATE_WAIT_MS)
	})
	const outcome = await Promise.race([scanner.worker.terminate().then(() => 'exited' as const), gaveUp]).catch(
		() => 'exited' as const,
	)
	clearTimeout(waited)
	if (outcome === 'gave-up') {
		logger.warn('[memory] an exclusion scanner did not stop when terminated; handing its slot on', {
			waitedMs: TERMINATE_WAIT_MS,
		})
	}
	markExited(scanner)
}

/**
 * Run one check on a thread of the pool: wait for a slot, take a warm thread or start one,
 * and afterwards put it back — or retire it when the check ran out of time (it is stuck in, or
 * lost to, that rule). Threads only start while holding a slot and only when none is idle, so
 * there are never more than `EXCLUSION_SCAN_CONCURRENCY` of them.
 */
async function withScanner(check: (scanner: Scanner) => Promise<Verdict>): Promise<Verdict> {
	await takeSlot()
	let scanner: Scanner | null = null
	try {
		let warm = idle.pop()
		while (warm && !warm.alive) warm = idle.pop()
		if (warm?.idleTimer) {
			clearTimeout(warm.idleTimer)
			warm.idleTimer = null
		}
		scanner = warm ?? (await startScanner())
		const verdict = await check(scanner)
		if ('timedOut' in verdict) await retire(scanner)
		else park(scanner)
		return verdict
	} catch (error) {
		if (scanner) await retire(scanner)
		throw error
	} finally {
		releaseSlot()
	}
}

/**
 * One piece of content against the rules, on a thread that holds a slot. Resolves with the
 * first matching rule's index, -1 for no match, or `timedOut` with the rule that was running
 * when the time ran out. A thread that dies mid-check (a regex that overflows its stack, say)
 * is treated the same way: there is no verdict, so the content does not get through.
 */
function scanOne(scanner: Scanner, ruleSet: RuleSet, content: string, timeoutMs: number): Promise<Verdict> {
	const { worker } = scanner
	const id = nextScanId++
	return new Promise((resolve) => {
		let testing = 0
		const finish = (verdict: Verdict) => {
			clearTimeout(timer)
			worker.off('message', onMessage)
			worker.off('error', onFailure)
			worker.off('exit', onFailure)
			resolve(verdict)
		}
		const onMessage = (message: ScannerMessage) => {
			if (message.type === 'ready' || message.id !== id) return
			if (message.type === 'testing') testing = message.index
			else finish({ index: message.index, hit: message.hit })
		}
		const onFailure = () => finish({ index: testing, timedOut: true })
		// Started here, with the thread in hand: time spent waiting for a slot is not counted.
		const timer = setTimeout(onFailure, timeoutMs)
		worker.on('message', onMessage)
		worker.on('error', onFailure)
		worker.on('exit', onFailure)
		worker.postMessage({ id, key: ruleSet.key, rules: ruleSet.rules, content })
	})
}

/** How busy the pool is right now: checks under way, checks waiting, and threads alive. */
export function exclusionScanLoad(): { scanning: number; waiting: number; threads: number } {
	return { scanning: slotsTaken, waiting: waiting.length, threads }
}

/**
 * The first rule each piece of content matches, or null, in the order given. A piece whose
 * check runs out of time — or whose thread dies — comes back as matched by the rule that was
 * running, with `timedOut: true`, and is logged.
 *
 * Pieces are checked one after another, each taking its turn for a thread, so a long mining
 * pass shares the pool with a chat turn's check instead of holding it.
 *
 * Throws only when no thread can be started at all, which callers treat as a failure rather
 * than as "nothing matched".
 */
export async function scanForExclusions(
	contents: string[],
	rules: CompiledExclusionRule[],
	options: ExclusionScanOptions = {},
): Promise<Array<ExclusionScanMatch | null>> {
	if (rules.length === 0 || contents.length === 0) return contents.map(() => null)
	const timeoutMs = options.timeoutMs ?? EXCLUSION_SCAN_TIMEOUT_MS
	const payload = rules.map((rule) => ({ kind: rule.kind, pattern: rule.pattern }))
	const ruleSet: RuleSet = { key: JSON.stringify(payload), rules: payload }

	const results: Array<ExclusionScanMatch | null> = []
	for (const content of contents) {
		const verdict = await withScanner((scanner) => scanOne(scanner, ruleSet, content, timeoutMs))
		if ('timedOut' in verdict) {
			const rule = rules[verdict.index] ?? rules[0]
			logger.warn('[memory] an exclusion rule ran out of time; treating the content as matched', {
				rule: rule.name,
				timeoutMs,
				contentLength: content.length,
			})
			results.push({
				ruleId: rule.id,
				ruleName: rule.name,
				sample: `no answer within ${timeoutMs} ms`,
				timedOut: true,
			})
			continue
		}
		const rule = verdict.index >= 0 ? rules[verdict.index] : null
		results.push(
			rule && verdict.hit !== null
				? { ruleId: rule.id, ruleName: rule.name, sample: redactSample(verdict.hit), timedOut: false }
				: null,
		)
	}
	return results
}

/** `scanForExclusions` for one piece of content. */
export async function scanForExclusion(
	content: string,
	rules: CompiledExclusionRule[],
	options: ExclusionScanOptions = {},
): Promise<ExclusionScanMatch | null> {
	const [match] = await scanForExclusions([content], rules, options)
	return match ?? null
}
