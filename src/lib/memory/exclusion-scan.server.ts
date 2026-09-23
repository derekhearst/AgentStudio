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
 * a deny list can afford; storing a secret is not. The next piece of content gets a fresh
 * worker.
 *
 * Because the check is bounded in time it is not bounded in length: the whole content is
 * scanned. It used to stop at 40,000 characters while the rest of the turn was still sent to
 * the extractor, embedded and stored, so a secret near the end of a long paste got through.
 *
 * The rules are applied exactly as `compileExclusionRule` in `./exclusions` applies them —
 * case-insensitive, no `g` flag, substrings by lower-cased `indexOf`, first rule in list
 * order wins — and the specs hold the two to the same cases.
 */

import { Worker } from 'node:worker_threads'
import { redactSample, type CompiledExclusionRule, type ExclusionMatch } from '$lib/memory/exclusions'
import { logger } from '$lib/observability/logger'

/** How long one piece of content may take against the whole rule set before it counts as matched. */
export const EXCLUSION_SCAN_TIMEOUT_MS = 1_000

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
 * file of its own for the bundler to find. It compiles the rules once, says so, then answers
 * one message per piece of content — announcing each rule before running it, so that when the
 * time runs out the caller knows which rule was still running.
 */
const SCANNER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const matchers = workerData.rules.map((rule) => {
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
parentPort.on('message', ({ content }) => {
	for (let index = 0; index < matchers.length; index += 1) {
		parentPort.postMessage({ type: 'testing', index })
		const hit = matchers[index](content)
		if (hit !== null) {
			parentPort.postMessage({ type: 'verdict', index, hit })
			return
		}
	}
	parentPort.postMessage({ type: 'verdict', index: -1, hit: null })
})
parentPort.postMessage({ type: 'ready' })
`

type ScannerMessage =
	| { type: 'ready' }
	| { type: 'testing'; index: number }
	| { type: 'verdict'; index: number; hit: string | null }

type Verdict = { index: number; hit: string | null } | { index: number; timedOut: true }

/** A worker with the rules compiled, once it has said it is ready. */
function startScanner(rules: CompiledExclusionRule[]): Promise<Worker> {
	const worker = new Worker(SCANNER_SOURCE, {
		eval: true,
		workerData: { rules: rules.map((rule) => ({ kind: rule.kind, pattern: rule.pattern })) },
	})
	// A scan in flight is kept alive by its timer; an idle worker must not hold the process open.
	worker.unref()
	// A worker 'error' with no listener is rethrown on this thread, and would take the server
	// down. Each scan listens for the errors that concern it; this catches the rest.
	worker.on('error', () => undefined)
	return new Promise((resolve, reject) => {
		const settle = () => {
			worker.off('message', onMessage)
			worker.off('error', onError)
			worker.off('exit', onExit)
		}
		const onMessage = (message: ScannerMessage) => {
			if (message.type !== 'ready') return
			settle()
			resolve(worker)
		}
		const onError = (error: unknown) => {
			settle()
			reject(error instanceof Error ? error : new Error(String(error)))
		}
		const onExit = (code: number) => {
			settle()
			reject(new Error(`the exclusion scanner exited before it was ready (code ${code})`))
		}
		worker.on('message', onMessage)
		worker.on('error', onError)
		worker.on('exit', onExit)
	})
}

/**
 * One piece of content against the rules. Resolves with the first matching rule's index, -1
 * for no match, or `timedOut` with the rule that was running when the time ran out. A worker
 * that dies mid-check (a regex that overflows its stack, say) is treated the same way: there
 * is no verdict, so the content does not get through.
 */
function scanOne(worker: Worker, content: string, timeoutMs: number): Promise<Verdict> {
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
			if (message.type === 'testing') testing = message.index
			else if (message.type === 'verdict') finish({ index: message.index, hit: message.hit })
		}
		const onFailure = () => finish({ index: testing, timedOut: true })
		const timer = setTimeout(onFailure, timeoutMs)
		worker.on('message', onMessage)
		worker.on('error', onFailure)
		worker.on('exit', onFailure)
		worker.postMessage({ content })
	})
}

/**
 * The first rule each piece of content matches, or null, in the order given. A piece whose
 * check runs out of time — or whose worker dies — comes back as matched by the rule that was
 * running, with `timedOut: true`, and is logged.
 *
 * Throws only when no worker can be started at all, which callers treat as a failure rather
 * than as "nothing matched".
 */
export async function scanForExclusions(
	contents: string[],
	rules: CompiledExclusionRule[],
	options: ExclusionScanOptions = {},
): Promise<Array<ExclusionScanMatch | null>> {
	if (rules.length === 0 || contents.length === 0) return contents.map(() => null)
	const timeoutMs = options.timeoutMs ?? EXCLUSION_SCAN_TIMEOUT_MS

	const results: Array<ExclusionScanMatch | null> = []
	let worker: Worker | null = null
	try {
		for (const content of contents) {
			worker ??= await startScanner(rules)
			const verdict = await scanOne(worker, content, timeoutMs)
			if ('timedOut' in verdict) {
				// The worker is stuck in (or lost to) that rule; the next piece gets a fresh one.
				void worker.terminate()
				worker = null
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
	} finally {
		if (worker) void worker.terminate()
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
