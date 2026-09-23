import { z } from 'zod'

/**
 * #33 — the pure half of the monitors domain.
 *
 * Everything here is isomorphic: no database, no SvelteKit, no `node:` imports. The job
 * handler, the remote functions, the agent tool and the `/monitors` page all share these
 * schemas and predicates, and the unit spec exercises them without Postgres.
 *
 * The three rules this file encodes, which are the ones that keep a monitor from becoming a
 * runaway:
 *
 *   1. Every monitor expires. `clampDeadline` refuses anything beyond
 *      `MONITOR_MAX_DEADLINE_DAYS` and has no "never" branch.
 *   2. Every monitor has a check budget. `clampMaxChecks` caps it; the runner retires the
 *      monitor as `exhausted` when it is spent.
 *   3. Firing is edge-triggered. `shouldFire` fires on the false→true transition only, so a
 *      condition that stays true for a week produces one action, not one per check.
 */

// ─────────── Caps ───────────

/** The issue's suggestion: a monitor may not outlive 30 days without an explicit extension. */
export const MONITOR_MAX_DEADLINE_DAYS = 30
/** A monitor is a background watcher, not a poller. One check a minute is the floor. */
export const MONITOR_MIN_INTERVAL_SECONDS = 60
export const MONITOR_MAX_INTERVAL_SECONDS = 24 * 60 * 60
export const MONITOR_DEFAULT_INTERVAL_SECONDS = 15 * 60
export const MONITOR_DEFAULT_MAX_CHECKS = 200
/** Ceiling on the per-monitor check budget, whatever the caller asks for. */
export const MONITOR_HARD_MAX_CHECKS = 2_000
/** Consecutive errored checks before the monitor gives up and asks for a human. */
export const MONITOR_MAX_CONSECUTIVE_ERRORS = 5
/** Errored checks back off geometrically, but never past this multiple of the interval. */
export const MONITOR_MAX_ERROR_BACKOFF_MULTIPLIER = 8
/**
 * How much of an observed value we keep on the row, for display. The hash covers the whole
 * thing, and so do the comparisons — this cap is about row size, not about what is seen.
 */
export const MONITOR_OBSERVATION_MAX_CHARS = 4_000
/** How much fetched context we hand the cheap model. Keeps the yes/no call cheap. */
export const MONITOR_MODEL_CONTEXT_MAX_CHARS = 12_000
/** Default model for the yes/no path. Cheap on purpose; overridable per monitor. */
export const MONITOR_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5'

/**
 * Tools a condition may observe with. Deliberately a read-only allowlist — a monitor runs
 * unattended on a timer with no human in the loop, so it may look at the world but never
 * change it. `Bash`, `Write`, `push_branch` and friends are absent by construction.
 */
export const MONITOR_OBSERVABLE_TOOLS = [
	'web_fetch',
	'web_search',
	'Grep',
	'Read',
	'file_info',
	'Glob',
	'git_status',
	'git_log',
	'git_diff',
	'list_pull_requests',
	'get_pull_request',
	'list_projects',
] as const

export type MonitorObservableTool = (typeof MONITOR_OBSERVABLE_TOOLS)[number]

// ─────────── Condition schemas ───────────

export const monitorCompareSchema = z.enum([
	/** Fire when the observation differs from the previous one. The first check is a baseline. */
	'changed',
	'equals',
	'not_equals',
	'contains',
	'not_contains',
	'matches',
	'not_empty',
])

export type MonitorCompare = z.infer<typeof monitorCompareSchema>

const observationSourceSchema = z.object({
	tool: z.enum(MONITOR_OBSERVABLE_TOOLS),
	args: z.record(z.string(), z.unknown()).default({}),
})

export const toolResultConditionSchema = z.object({
	kind: z.literal('tool_result'),
	tool: z.enum(MONITOR_OBSERVABLE_TOOLS),
	args: z.record(z.string(), z.unknown()).default({}),
	/**
	 * Dotted path into the tool result, e.g. `text`, `0.status`, `items.3.title`. Omit to
	 * compare the whole result. Narrowing the path is what makes `changed` useful — a raw
	 * `web_fetch` result carries a `fetchedAt` timestamp that changes on every single check.
	 */
	extract: z.string().trim().max(200).optional(),
	compare: monitorCompareSchema.default('changed'),
	/** Operand for equals / contains / matches. Ignored by `changed` and `not_empty`. */
	value: z.string().max(2_000).optional(),
})

export const modelQuestionConditionSchema = z.object({
	kind: z.literal('model_question'),
	/** A yes/no question. "Has the maintainer replied to issue 412?" */
	question: z.string().trim().min(1).max(1_000),
	/** Read-only tool calls whose results become the model's context. */
	context: z.array(observationSourceSchema).min(1).max(3),
	model: z.string().trim().min(1).max(120).optional(),
})

export const monitorConditionSchema = z.discriminatedUnion('kind', [
	toolResultConditionSchema,
	modelQuestionConditionSchema,
])

export type ToolResultCondition = z.infer<typeof toolResultConditionSchema>
export type ModelQuestionCondition = z.infer<typeof modelQuestionConditionSchema>
export type MonitorCondition = z.infer<typeof monitorConditionSchema>

// ─────────── Action schemas ───────────

export const monitorActionSchema = z.enum(['start_conversation', 'review_item', 'push', 'run_automation'])
export type MonitorAction = z.infer<typeof monitorActionSchema>

export const monitorActionConfigSchema = z.object({
	/** `start_conversation`: the prompt seeded as the opening user message. */
	prompt: z.string().trim().max(8_000).optional(),
	/** `start_conversation`: agent to run as. Falls back to the monitor's agent, then the default. */
	agentId: z.string().uuid().nullable().optional(),
	/** `run_automation`: which automation to enqueue. */
	automationId: z.string().uuid().optional(),
	/** `push` / `review_item`: override the generated headline. */
	title: z.string().trim().max(200).optional(),
	/** `push`: body text. Defaults to the observed value. */
	body: z.string().trim().max(1_000).optional(),
	/** `push`: deep link. */
	url: z.string().trim().max(500).optional(),
	/** `review_item`: inbox severity. Defaults to `warning`. */
	severity: z.enum(['info', 'warning', 'critical']).optional(),
})

export type MonitorActionConfig = z.infer<typeof monitorActionConfigSchema>

/**
 * Per-action required-field check. Returns an error string, or null when the config is
 * usable. Kept separate from the zod schema because the requirement depends on the action,
 * and a discriminated union over four actions would make the tool schema unreadable for the
 * model.
 */
export function validateActionConfig(action: MonitorAction, config: MonitorActionConfig): string | null {
	if (action === 'start_conversation' && !config.prompt?.trim()) {
		return 'action "start_conversation" requires actionConfig.prompt — the seeded opening message'
	}
	if (action === 'run_automation' && !config.automationId) {
		return 'action "run_automation" requires actionConfig.automationId'
	}
	return null
}

// ─────────── Observation ───────────

export type MonitorObservation = {
	/**
	 * Normalized rendering of what was seen, cut at `MONITOR_OBSERVATION_MAX_CHARS`. For
	 * display only: a comparison reads the full value, which is never stored.
	 */
	value: string
	/** Hash of the FULL normalized value — the change-detection key. */
	hash: string
	observedAt: string
	/** Whether the condition was satisfied at this observation. */
	met: boolean
	truncated?: boolean
	/** Free-form one-liner — the model's rationale, or why a comparison came out the way it did. */
	note?: string
}

/**
 * Deterministic JSON with object keys sorted, so two structurally equal results hash the
 * same regardless of key order. `undefined` collapses to null; cycles degrade to the string
 * `"[circular]"` rather than throwing (a tool result should never contain one, but a monitor
 * must not die because one did).
 */
export function stableStringify(input: unknown): string {
	const seen = new WeakSet<object>()
	const walk = (value: unknown): unknown => {
		if (value === undefined) return null
		if (value === null || typeof value !== 'object') {
			return typeof value === 'bigint' ? value.toString() : value
		}
		if (seen.has(value as object)) return '[circular]'
		seen.add(value as object)
		if (Array.isArray(value)) return value.map(walk)
		const source = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(source).sort()) out[key] = walk(source[key])
		return out
	}
	const normalized = walk(input)
	// A bare string stays bare so that text extracted from `web_fetch` compares as text
	// rather than as a JSON-quoted literal.
	return typeof normalized === 'string' ? normalized : JSON.stringify(normalized)
}

/**
 * Two interleaved 32-bit FNV-1a-style digests concatenated to 16 hex chars. Not a
 * cryptographic hash and does not need to be — it is a change-detection key over data we
 * already hold. Deliberately dependency-free and isomorphic so the same function runs in
 * the job handler and in the browser.
 */
export function hashValue(input: string): string {
	let a = 0x811c_9dc5
	let b = 0xc2b2_ae35
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i)
		a = Math.imul(a ^ code, 0x0100_0193) >>> 0
		b = Math.imul(b ^ (code + i), 0x85eb_ca6b) >>> 0
	}
	return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

export function buildObservation(raw: unknown, met: boolean, note?: string, now = new Date()): MonitorObservation {
	return observationFromText(stableStringify(raw), met, note, now)
}

/** `buildObservation` for a value already rendered by `stableStringify`. */
export function observationFromText(full: string, met: boolean, note?: string, now = new Date()): MonitorObservation {
	const truncated = full.length > MONITOR_OBSERVATION_MAX_CHARS
	return {
		value: truncated ? `${full.slice(0, MONITOR_OBSERVATION_MAX_CHARS)}…` : full,
		hash: hashValue(full),
		observedAt: now.toISOString(),
		met,
		...(truncated ? { truncated: true } : {}),
		...(note ? { note: note.slice(0, 500) } : {}),
	}
}

/**
 * Walk a dotted path into a tool result. Numeric segments index arrays. Returns `undefined`
 * when any segment is missing — the caller decides whether that is "empty" or an error.
 */
export function extractPath(root: unknown, path?: string): unknown {
	if (!path || path.trim().length === 0) return root
	let current: unknown = root
	for (const rawSegment of path.split('.')) {
		const segment = rawSegment.trim()
		if (segment.length === 0) continue
		if (current === null || current === undefined) return undefined
		if (Array.isArray(current)) {
			const index = Number(segment)
			if (!Number.isInteger(index)) return undefined
			current = current.at(index)
			continue
		}
		if (typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[segment]
	}
	return current
}

// ─────────── Comparison ───────────

export type ComparisonInput = {
	compare: MonitorCompare
	/** Observation built from this check. */
	current: MonitorObservation
	/** Observation stored from the previous successful check, if any. */
	previous: MonitorObservation | null
	/** Operand for equals / contains / matches. */
	expected?: string
	/**
	 * The full normalized value, when the caller has it. `current.value` is cut at
	 * `MONITOR_OBSERVATION_MAX_CHARS` with a trailing "…", so comparing against it would miss
	 * anything past the cut — a `not_contains "Out of stock"` whose phrase sits at character
	 * 9,000 fired on the first check — and `equals` could never match a long value.
	 */
	fullValue?: string
}

export type ComparisonResult = { met: boolean; reason: string }

/**
 * Decide whether the condition is satisfied right now. Pure — no notion of firing, which is
 * `shouldFire`'s job.
 *
 * `changed` deserves a note: the FIRST check of a `changed` monitor is always "not met". It
 * records a baseline. Without that rule every `changed` monitor would fire the instant it
 * was created, which is the opposite of watching for a change.
 */
export function evaluateComparison(input: ComparisonInput): ComparisonResult {
	const { compare, current, previous, expected } = input
	const value = input.fullValue ?? current.value
	switch (compare) {
		case 'changed': {
			if (!previous) return { met: false, reason: 'baseline recorded — first observation never fires' }
			const met = previous.hash !== current.hash
			return { met, reason: met ? 'value differs from the last observation' : 'value unchanged' }
		}
		case 'equals': {
			const met = normalizeScalar(value) === normalizeScalar(expected ?? '')
			return { met, reason: met ? 'value equals the operand' : 'value differs from the operand' }
		}
		case 'not_equals': {
			const met = normalizeScalar(value) !== normalizeScalar(expected ?? '')
			return { met, reason: met ? 'value differs from the operand' : 'value equals the operand' }
		}
		case 'contains': {
			const met = value.toLowerCase().includes((expected ?? '').toLowerCase())
			return { met, reason: met ? 'operand found in value' : 'operand not found in value' }
		}
		case 'not_contains': {
			const met = !value.toLowerCase().includes((expected ?? '').toLowerCase())
			return { met, reason: met ? 'operand absent from value' : 'operand present in value' }
		}
		case 'matches': {
			// An invalid pattern is a configuration error, not a transient failure. Throwing
			// routes it into the error path, which backs off and eventually asks for a human
			// rather than silently reporting "not met" forever.
			let re: RegExp
			try {
				re = new RegExp(expected ?? '')
			} catch {
				throw new Error(`monitor condition has an invalid regular expression: ${expected ?? ''}`)
			}
			const met = re.test(value)
			return { met, reason: met ? 'pattern matched' : 'pattern did not match' }
		}
		case 'not_empty': {
			const met = !isEmptyRendering(value)
			return { met, reason: met ? 'value is non-empty' : 'value is empty' }
		}
		default: {
			const exhaustive: never = compare
			throw new Error(`unknown comparison: ${String(exhaustive)}`)
		}
	}
}

function normalizeScalar(value: string): string {
	return value.trim().replace(/^"(.*)"$/s, '$1')
}

/** `stableStringify` renders emptiness several ways; treat them all as empty. */
function isEmptyRendering(value: string): boolean {
	const trimmed = value.trim()
	return trimmed === '' || trimmed === '""' || trimmed === 'null' || trimmed === '[]' || trimmed === '{}'
}

export type ToolResultObservation =
	| { outcome: 'observed'; observation: MonitorObservation; met: boolean }
	| { outcome: 'error'; message: string }

/**
 * The `tool_result` half of a check once the tool has answered: narrow the result, compare
 * it, and build the observation to store. Pure, so the rules are pinned without a tool call.
 *
 * Two rules live here:
 *   - the comparison reads the FULL value; only the stored `value` is truncated;
 *   - an `extract` path that is not in the result is an ERROR, not an observation of
 *     "null". The create form pre-fills `text` (right for `web_fetch`), and a tool whose
 *     result has no `text` would otherwise observe the literal "null" on every check —
 *     a `changed` monitor never fires and quietly burns its budget, a `not_equals` one
 *     fires on the first check. An explicit `null` at the path is still a real value.
 */
export function observeToolResult(
	condition: ToolResultCondition,
	raw: unknown,
	previous: MonitorObservation | null,
	now = new Date(),
): ToolResultObservation {
	const extracted = extractPath(raw, condition.extract)
	if (extracted === undefined && condition.extract?.trim()) {
		return {
			outcome: 'error',
			message: `extract path "${condition.extract.trim()}" was not found in the ${condition.tool} result`,
		}
	}
	const full = stableStringify(extracted)
	const candidate = observationFromText(full, false, undefined, now)
	const comparison = evaluateComparison({
		compare: condition.compare,
		current: candidate,
		previous,
		expected: condition.value,
		fullValue: full,
	})
	return {
		outcome: 'observed',
		met: comparison.met,
		observation: { ...candidate, met: comparison.met, note: comparison.reason },
	}
}

/**
 * The debounce. Fire on the rising edge only: the condition is satisfied now and was not at
 * the previous check. A condition that stays true is a state, not an event.
 */
export function shouldFire(met: boolean, previouslyMet: boolean): boolean {
	return met && !previouslyMet
}

// ─────────── Scheduling + clamps ───────────

/**
 * When the next check is due. Healthy monitors land exactly one interval out; an errored
 * monitor backs off geometrically (2× per consecutive error, capped) so a monitor pointed at
 * a dead host stops hammering it long before the error budget runs out.
 */
export function computeNextCheckAt(now: Date, intervalSeconds: number, consecutiveErrors = 0): Date {
	const interval = clampInterval(intervalSeconds)
	const multiplier =
		consecutiveErrors > 0
			? Math.min(2 ** consecutiveErrors, MONITOR_MAX_ERROR_BACKOFF_MULTIPLIER)
			: 1
	return new Date(now.getTime() + interval * multiplier * 1_000)
}

export function clampInterval(intervalSeconds: number): number {
	if (!Number.isFinite(intervalSeconds)) return MONITOR_DEFAULT_INTERVAL_SECONDS
	return Math.min(MONITOR_MAX_INTERVAL_SECONDS, Math.max(MONITOR_MIN_INTERVAL_SECONDS, Math.floor(intervalSeconds)))
}

export function clampMaxChecks(maxChecks: number | undefined): number {
	if (maxChecks === undefined || !Number.isFinite(maxChecks)) return MONITOR_DEFAULT_MAX_CHECKS
	return Math.min(MONITOR_HARD_MAX_CHECKS, Math.max(1, Math.floor(maxChecks)))
}

export const MONITOR_MAX_DEADLINE_MS = MONITOR_MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1000

/**
 * Resolve a requested deadline into an allowed one. There is no "no deadline" branch:
 * omitting it yields the maximum, and asking for more than the maximum silently gets the
 * maximum. Anything in the past yields the minimum useful window (one interval out), so a
 * clock skew cannot create a monitor that is born expired.
 */
export function clampDeadline(requested: Date | string | null | undefined, now = new Date(), intervalSeconds = MONITOR_DEFAULT_INTERVAL_SECONDS): Date {
	const ceiling = new Date(now.getTime() + MONITOR_MAX_DEADLINE_MS)
	if (requested === null || requested === undefined) return ceiling
	const parsed = requested instanceof Date ? requested : new Date(requested)
	if (Number.isNaN(parsed.getTime())) return ceiling
	if (parsed.getTime() > ceiling.getTime()) return ceiling
	const floor = new Date(now.getTime() + clampInterval(intervalSeconds) * 1_000)
	if (parsed.getTime() < floor.getTime()) return floor
	return parsed
}

// ─────────── Model path helpers ───────────

/**
 * Turn the cheap model's answer into a verdict. Accepts a leading YES/NO with or without
 * punctuation, quotes or a trailing rationale. Returns null when the answer is unreadable —
 * the runner treats that as an error (backoff), not as "no", because silently reading an
 * unparseable answer as "condition not met" would make a monitor quietly useless.
 */
export function parseYesNo(answer: string): boolean | null {
	const head = answer.trim().replace(/^[^a-z]*/i, '').slice(0, 24).toLowerCase()
	if (/^y(es)?\b/.test(head) || head.startsWith('true')) return true
	if (/^no?\b/.test(head) || head.startsWith('false')) return false
	return null
}

/** The yes/no prompt. One line of output, so the completion is a handful of tokens. */
export function buildModelQuestionPrompt(question: string, context: string): string {
	const trimmed =
		context.length > MONITOR_MODEL_CONTEXT_MAX_CHARS
			? `${context.slice(0, MONITOR_MODEL_CONTEXT_MAX_CHARS)}\n…[context truncated]`
			: context
	return [
		'You are a monitoring check. Answer the question strictly from the CONTEXT below.',
		'Reply with exactly one line: "YES — <=12 word reason" or "NO — <=12 word reason".',
		'If the context does not contain enough information to say yes, answer NO.',
		'',
		`QUESTION: ${question}`,
		'',
		'CONTEXT:',
		trimmed,
	].join('\n')
}

// ─────────── Presentation ───────────

/** One-line English rendering of what a monitor is watching. Used by the UI and the tool. */
export function describeCondition(condition: MonitorCondition): string {
	if (condition.kind === 'model_question') {
		const sources = condition.context.map((c) => c.tool).join(', ')
		return `asks a model "${condition.question}" over ${sources || 'no context'}`
	}
	const target = condition.extract ? `${condition.tool}.${condition.extract}` : condition.tool
	switch (condition.compare) {
		case 'changed':
			return `${target} changes`
		case 'not_empty':
			return `${target} is non-empty`
		default:
			return `${target} ${condition.compare.replace('_', ' ')} "${condition.value ?? ''}"`
	}
}

/** Terminal statuses never get checked again. */
export const MONITOR_TERMINAL_STATUSES = ['fired', 'expired', 'exhausted', 'failed', 'canceled'] as const

export function isTerminalStatus(status: string): boolean {
	return (MONITOR_TERMINAL_STATUSES as readonly string[]).includes(status)
}
