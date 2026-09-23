/**
 * #38 — "what did the agents actually do this week?"
 *
 * The numbers behind the `/activity` usage strip and the weekly usage digest. They come from
 * ledgers that already exist: `llm_usage` (tokens and metered spend per model and agent),
 * `tool_usage` (one row per tool call since the ledger fix), `chat_runs`, `automation_runs`,
 * `budget_limits`, `review_items` and `monitors`. The queries live in `usage-digest.server.ts`;
 * everything here is pure, so a spec can pin the window math, the anomaly thresholds and the
 * markdown without a database.
 *
 * ## Tokens first, dollars second
 *
 * Claude runs go through the subscription and are logged at $0 (the chat stream forces
 * `costOverride: 0`), so a dollar-first view would look confidently wrong — a busy week on
 * the subscription reads as a free one. Tokens are the real measure and lead everywhere.
 * Dollars are labelled *metered*: what gateway models, OpenRouter calls and paid tools
 * actually charged.
 *
 * ## Numbers and anomalies, nothing else
 *
 * The digest restates the ledgers; it does not interpret them. It is rendered by code with
 * no model call, so sending it every week costs nothing — the alternative, a model writing
 * prose about numbers the strip already shows, is the "digest nobody reads" the issue warns
 * about, with a bill attached.
 */

import { AUTOMATION_RUN_RETENTION_DAYS } from '../automations/failure-policy'

/** The windows the strip offers. The digest automation may ask for any 1–30 days. */
export const USAGE_DIGEST_WINDOW_DAYS = [1, 7, 30] as const
export type UsageDigestWindowDays = (typeof USAGE_DIGEST_WINDOW_DAYS)[number]
export const DEFAULT_USAGE_DIGEST_DAYS = 7
/**
 * The longest window. `automation_runs` keeps only this many days, so a longer window would
 * silently report fewer automation runs than actually happened.
 */
export const MAX_USAGE_DIGEST_DAYS = AUTOMATION_RUN_RETENTION_DAYS

const DAY_MS = 24 * 60 * 60 * 1000

/*
 * Anomaly thresholds. Guesses, kept as named constants so they are easy to tune and so the
 * spec pins each one at its edge.
 */

/** A window must be more than this multiple of the previous one to count as a spike. */
export const SPIKE_RATIO = 2
/** …and have at least this much metered spend, so $0.01 → $0.03 is not news. */
export const SPEND_SPIKE_FLOOR_USD = 1
/** …or at least this many tokens (in + out). */
export const TOKEN_SPIKE_FLOOR = 1_000_000
/** Below this many finished runs a failure rate is noise, and none is reported. */
export const MIN_FINISHED_RUNS_FOR_RATE = 4
/** Flag the window when at least this share of finished runs failed. */
export const RUN_FAILURE_RATE_ALERT = 0.25
/** Flag a budget limit once this share of it is spent. */
export const BUDGET_NEAR_LIMIT_PCT = 0.8
/** Flag an active monitor whose last N checks all errored. */
export const MONITOR_ERROR_STREAK_ALERT = 3

/** Entries kept per breakdown list. */
export const DIGEST_TOP_N = 5
/** Anomalies printed in the markdown before "…and N more". */
export const DIGEST_MARKDOWN_MAX_ANOMALIES = 10

/**
 * The prompt that turns a maintenance automation into the usage digest.
 *
 * A prompt that is *only* this placeholder is rendered by code: no model call, cost $0.
 * `{{usage_digest:30}}` picks the window in days.
 */
export const USAGE_DIGEST_PROMPT = '{{usage_digest}}'
/** The schedule the `/activity` opt-in creates: Monday 09:00 in the owner's zone. */
export const USAGE_DIGEST_CRON = '0 9 * * 1'
const USAGE_DIGEST_PROMPT_RE = /^\{\{\s*usage_digest\s*(?::\s*(\d{1,4})\s*)?\}\}$/

export type DigestWindow = {
	days: number
	/** Start of the window, inclusive. */
	since: Date
	/** End of the window, exclusive. */
	until: Date
	/** Start of the previous window, which ends where this one starts. */
	prevSince: Date
}

/**
 * A rolling window ending now, and the equally long window before it.
 *
 * Rolling rather than calendar: "this week" computed from server-local midnight means UTC
 * in the container and a different Monday for the owner, and a calendar window is nearly
 * empty on its first day, which makes every comparison against the previous one a spike.
 */
export function resolveDigestWindow(days: number, now: Date = new Date()): DigestWindow {
	const clamped = clampDigestDays(days)
	const until = new Date(now.getTime())
	const since = new Date(until.getTime() - clamped * DAY_MS)
	const prevSince = new Date(since.getTime() - clamped * DAY_MS)
	return { days: clamped, since, until, prevSince }
}

function clampDigestDays(days: number): number {
	if (!Number.isFinite(days)) return DEFAULT_USAGE_DIGEST_DAYS
	return Math.min(MAX_USAGE_DIGEST_DAYS, Math.max(1, Math.round(days)))
}

/**
 * The window a digest prompt asks for, or null when the prompt is not the digest.
 *
 * Only a prompt that is the placeholder and nothing else counts: text around it would be
 * an instruction for a model, and this path has none. An out-of-range window is clamped
 * rather than rejected, because rejecting it would hand the literal placeholder to a model.
 */
export function parseUsageDigestPrompt(prompt: string | null | undefined): number | null {
	const match = (prompt ?? '').trim().match(USAGE_DIGEST_PROMPT_RE)
	if (!match) return null
	return match[1] ? clampDigestDays(Number(match[1])) : DEFAULT_USAGE_DIGEST_DAYS
}

/**
 * Whether an automation is the usage digest: a maintenance automation whose prompt is the
 * placeholder. Its runs are rendered by code and cannot spend anything.
 */
export function isUsageDigestAutomation(automation: { mode: string; prompt: string | null }): boolean {
	return automation.mode === 'maintenance' && parseUsageDigestPrompt(automation.prompt) !== null
}

/**
 * Whether the automation ledger still holds the whole previous window, which is what
 * "newly failing" compares against.
 *
 * Past half the retention it does not: for a 30-day window the previous 30 days are already
 * pruned, so every automation that failed at all would read as "no failures before".
 */
export function automationHistoryCoversPreviousWindow(days: number): boolean {
	return days * 2 <= AUTOMATION_RUN_RETENTION_DAYS
}

/** "24 hours", "7 days", "30 days". */
export function digestWindowLabel(days: number): string {
	return days === 1 ? '24 hours' : `${days} days`
}

/**
 * Share of finished runs that failed, or null when too few runs finished to say.
 *
 * Canceled runs are left out — a run the owner stopped did not fail — and so are runs
 * still in flight, which have no outcome yet.
 */
export function failureRate(counts: { completed: number; failed: number }): number | null {
	const finished = counts.completed + counts.failed
	if (finished < MIN_FINISHED_RUNS_FOR_RATE) return null
	return counts.failed / finished
}

/* ── Inputs: what the queries hand over ─────────────────────────────────── */

export type DigestLedgerTotals = {
	tokensIn: number
	tokensOut: number
	tokensCacheRead: number
	tokensCacheWrite: number
	/** Metered model spend in USD. */
	costUsd: number
	/** `llm_usage` rows — one per chat turn or model call. */
	calls: number
}

export type DigestModel = {
	model: string
	tokensIn: number
	tokensOut: number
	tokensCacheRead: number
	tokensCacheWrite: number
	costUsd: number
	calls: number
	/** Any row for this model came from a subscription run, whose dollars are logged as $0. */
	subscription: boolean
}

export type DigestAgent = {
	agentId: string
	name: string | null
	tokensIn: number
	tokensOut: number
	costUsd: number
	calls: number
}

export type DigestAutomation = {
	automationId: string
	description: string
	enabled: boolean
	disabledReason: string | null
	/** The failure policy switched it off during this window. */
	disabledInWindow: boolean
	runs: number
	completed: number
	failed: number
	/** Skipped without running: a budget limit blocked it, or its agent was paused (#66). */
	blocked: number
	costUsd: number
	/** Failed runs in the previous window — what makes a failure "new". */
	prevFailed: number
}

export type DigestTool = {
	toolName: string
	calls: number
	failed: number
	costUsd: number
}

export type DigestBudgetHeadroom = {
	id: string
	scope: 'global' | 'project' | 'agent' | 'run'
	scopeId: string | null
	/** Human name for the scope, e.g. an agent's name. Null for global. */
	scopeLabel: string | null
	period: 'day' | 'week' | 'month' | 'run'
	limitUsd: number
	spendUsd: number
	/** spend / limit. Over 1 means over the limit. */
	pct: number
	action: 'block' | 'notify_only'
}

export type DigestMonitor = {
	monitorId: string
	name: string
	status: string
	fireCount: number
	consecutiveErrors: number
	/** The monitor's last change (retirement, for a retired one) falls inside the window. */
	updatedInWindow: boolean
}

export type UsageDigestInput = {
	window: DigestWindow
	llm: { current: DigestLedgerTotals; previous: DigestLedgerTotals }
	models: DigestModel[]
	agents: DigestAgent[]
	/** `chat_runs` created in the window, counted per state. */
	runStates: Array<{ state: string; count: number }>
	automations: DigestAutomation[]
	tools: {
		calls: number
		failed: number
		costUsd: number
		previousCostUsd: number
		top: DigestTool[]
	}
	budget: DigestBudgetHeadroom[]
	/** Open and in-progress review items, counted per severity. */
	inbox: Array<{ severity: string; count: number }>
	monitors: DigestMonitor[]
}

/* ── Output: the digest ─────────────────────────────────────────────────── */

export type DigestAnomalyKind =
	| 'spend_spike'
	| 'token_spike'
	| 'run_failure_rate'
	| 'automation_disabled'
	| 'automation_newly_failing'
	| 'monitor_never_fired'
	| 'monitor_erroring'
	| 'budget_near_limit'

export type DigestAnomaly = {
	kind: DigestAnomalyKind
	severity: 'warning' | 'critical'
	/** One plain-English sentence, shared by the strip and the markdown. */
	message: string
	/** Where to go to look into it, when there is such a page. */
	href: string | null
}

export type UsageDigest = {
	days: number
	since: string
	until: string
	tokens: {
		in: number
		out: number
		cacheRead: number
		cacheWrite: number
		/** in + out. Cache is shown separately, because it dwarfs both and costs far less. */
		total: number
		previousTotal: number
	}
	metered: {
		usd: number
		previousUsd: number
		llmUsd: number
		toolUsd: number
	}
	/** Some usage in the window came from subscription runs, which log $0. */
	hasSubscriptionUsage: boolean
	llmCalls: number
	models: DigestModel[]
	agents: DigestAgent[]
	runs: {
		total: number
		completed: number
		failed: number
		canceled: number
		inFlight: number
		failureRate: number | null
	}
	automations: {
		runs: number
		completed: number
		failed: number
		blocked: number
		costUsd: number
		/** Busiest first: most failures, then most spend, then most runs. */
		items: DigestAutomation[]
	}
	tools: {
		calls: number
		failed: number
		top: DigestTool[]
	}
	budget: {
		limits: DigestBudgetHeadroom[]
		/** The limit closest to (or furthest over) its cap. Null means no limits are set. */
		tightest: DigestBudgetHeadroom | null
	}
	inbox: { open: number; critical: number; warning: number; info: number }
	anomalies: DigestAnomaly[]
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

const TOKEN_UNITS = ['K', 'M', 'B'] as const

export function formatDigestTokens(n: number): string {
	if (!n) return '0'
	if (Math.round(n) < 1_000) return String(Math.round(n))
	// Step up a unit when rounding would print "1000.0": 999,999 is 1.0M, not 1000.0K.
	let value = n / 1_000
	let unit = 0
	while (unit < TOKEN_UNITS.length - 1 && Number(value.toFixed(1)) >= 1_000) {
		value /= 1_000
		unit++
	}
	return `${value.toFixed(1)}${TOKEN_UNITS[unit]}`
}

export function formatDigestUsd(n: number): string {
	if (!n) return '$0.00'
	return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

export function formatDigestPct(ratio: number): string {
	return `${Math.round(ratio * 100)}%`
}

/** User-supplied names go into one-line sentences and markdown bullets. */
function oneLine(value: string, max = 60): string {
	const flat = value.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describeLimit(limit: DigestBudgetHeadroom): string {
	const scope =
		limit.scope === 'global'
			? 'Global'
			: limit.scopeLabel
				? `${limit.scope === 'agent' ? 'Agent' : 'Project'} “${oneLine(limit.scopeLabel, 40)}”`
				: limit.scope === 'agent'
					? 'Agent'
					: 'Project'
	const period = limit.period === 'day' ? 'daily' : limit.period === 'week' ? 'weekly' : 'monthly'
	return `${scope} ${period} limit`
}

/* ── Anomalies ──────────────────────────────────────────────────────────── */

const RETIREMENT_PHRASE: Record<string, string> = {
	expired: 'reached its deadline',
	exhausted: 'used up its checks',
	failed: 'gave up after repeated errors',
}

function isSpike(current: number, previous: number, floor: number): boolean {
	return current >= floor && current > previous * SPIKE_RATIO
}

/**
 * The handful of things in a window worth a person's attention, most severe first.
 *
 * Each rule is deliberately blunt and has a floor, because a digest that cries wolf every
 * week gets ignored — and then the week it matters goes unread too.
 */
export function detectAnomalies(input: UsageDigestInput): DigestAnomaly[] {
	const anomalies: DigestAnomaly[] = []
	const label = digestWindowLabel(input.window.days)

	const meteredNow = input.llm.current.costUsd + input.tools.costUsd
	const meteredBefore = input.llm.previous.costUsd + input.tools.previousCostUsd
	if (isSpike(meteredNow, meteredBefore, SPEND_SPIKE_FLOOR_USD)) {
		anomalies.push({
			kind: 'spend_spike',
			severity: 'warning',
			message: `Metered spend is ${formatDigestUsd(meteredNow)}, up from ${formatDigestUsd(meteredBefore)} the previous ${label}.`,
			href: '/review',
		})
	}

	const tokensNow = input.llm.current.tokensIn + input.llm.current.tokensOut
	const tokensBefore = input.llm.previous.tokensIn + input.llm.previous.tokensOut
	if (isSpike(tokensNow, tokensBefore, TOKEN_SPIKE_FLOOR)) {
		anomalies.push({
			kind: 'token_spike',
			severity: 'warning',
			message: `${formatDigestTokens(tokensNow)} tokens used, up from ${formatDigestTokens(tokensBefore)} the previous ${label}.`,
			href: null,
		})
	}

	const runs = countRunStates(input.runStates)
	const rate = failureRate(runs)
	if (rate !== null && rate >= RUN_FAILURE_RATE_ALERT) {
		anomalies.push({
			kind: 'run_failure_rate',
			severity: 'warning',
			message: `${formatDigestPct(rate)} of finished runs failed (${runs.failed} of ${runs.completed + runs.failed}).`,
			// Recent failures are listed on /review; there is no run index page.
			href: '/review',
		})
	}

	// A failure is only "new" against a previous window the ledger still holds in full.
	const canJudgeNewFailures = automationHistoryCoversPreviousWindow(input.window.days)
	for (const automation of input.automations) {
		const name = oneLine(automation.description)
		if (automation.disabledInWindow && automation.disabledReason === 'consecutive_failures') {
			anomalies.push({
				kind: 'automation_disabled',
				severity: 'critical',
				message: `Automation “${name}” has been switched off after failing repeatedly.`,
				href: '/automations',
			})
			// Switched off says everything "newly failing" would, and more.
			continue
		}
		if (canJudgeNewFailures && automation.failed > 0 && automation.prevFailed === 0) {
			anomalies.push({
				kind: 'automation_newly_failing',
				severity: 'warning',
				message: `Automation “${name}” failed ${automation.failed === 1 ? 'once' : `${automation.failed} times`}, after no failures the previous ${label}.`,
				href: '/automations',
			})
		}
	}

	for (const monitor of input.monitors) {
		const name = oneLine(monitor.name)
		const phrase = RETIREMENT_PHRASE[monitor.status]
		if (phrase && monitor.fireCount === 0 && monitor.updatedInWindow) {
			anomalies.push({
				kind: 'monitor_never_fired',
				severity: 'warning',
				message: `Monitor “${name}” ${phrase} without ever firing.`,
				href: '/monitors',
			})
		} else if (monitor.status === 'active' && monitor.consecutiveErrors >= MONITOR_ERROR_STREAK_ALERT) {
			anomalies.push({
				kind: 'monitor_erroring',
				severity: 'warning',
				message: `Monitor “${name}” has errored on its last ${monitor.consecutiveErrors} checks.`,
				href: '/monitors',
			})
		}
	}

	for (const limit of input.budget) {
		if (limit.pct < BUDGET_NEAR_LIMIT_PCT) continue
		anomalies.push({
			kind: 'budget_near_limit',
			severity: limit.pct >= 1 ? 'critical' : 'warning',
			message: `${describeLimit(limit)} is ${formatDigestPct(limit.pct)} spent (${formatDigestUsd(limit.spendUsd)} of ${formatDigestUsd(limit.limitUsd)}).`,
			href: null,
		})
	}

	// Stable sort: critical first, otherwise in the order the rules ran.
	return anomalies
		.map((anomaly, index) => ({ anomaly, index }))
		.sort((a, b) => severityRank(a.anomaly) - severityRank(b.anomaly) || a.index - b.index)
		.map(({ anomaly }) => anomaly)
}

function severityRank(anomaly: DigestAnomaly): number {
	return anomaly.severity === 'critical' ? 0 : 1
}

function countRunStates(rows: Array<{ state: string; count: number }>) {
	const counts = { total: 0, completed: 0, failed: 0, canceled: 0, inFlight: 0 }
	for (const row of rows) {
		counts.total += row.count
		if (row.state === 'completed') counts.completed += row.count
		else if (row.state === 'failed') counts.failed += row.count
		else if (row.state === 'canceled') counts.canceled += row.count
		else counts.inFlight += row.count
	}
	return counts
}

/* ── Assembly ───────────────────────────────────────────────────────────── */

const byTokens = (a: { tokensIn: number; tokensOut: number; costUsd: number }, b: typeof a) =>
	b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || b.costUsd - a.costUsd

/** Turn the raw aggregates into the digest the strip and the markdown both read. */
export function assembleUsageDigest(input: UsageDigestInput): UsageDigest {
	const { current, previous } = input.llm
	const runCounts = countRunStates(input.runStates)

	const inbox = { open: 0, critical: 0, warning: 0, info: 0 }
	for (const row of input.inbox) {
		inbox.open += row.count
		if (row.severity === 'critical' || row.severity === 'warning' || row.severity === 'info') {
			inbox[row.severity] += row.count
		}
	}

	const automationTotals = { runs: 0, completed: 0, failed: 0, blocked: 0, costUsd: 0 }
	for (const automation of input.automations) {
		automationTotals.runs += automation.runs
		automationTotals.completed += automation.completed
		automationTotals.failed += automation.failed
		automationTotals.blocked += automation.blocked
		automationTotals.costUsd += automation.costUsd
	}

	const limits = [...input.budget].sort((a, b) => b.pct - a.pct)

	return {
		days: input.window.days,
		since: input.window.since.toISOString(),
		until: input.window.until.toISOString(),
		tokens: {
			in: current.tokensIn,
			out: current.tokensOut,
			cacheRead: current.tokensCacheRead,
			cacheWrite: current.tokensCacheWrite,
			total: current.tokensIn + current.tokensOut,
			previousTotal: previous.tokensIn + previous.tokensOut,
		},
		metered: {
			usd: current.costUsd + input.tools.costUsd,
			previousUsd: previous.costUsd + input.tools.previousCostUsd,
			llmUsd: current.costUsd,
			toolUsd: input.tools.costUsd,
		},
		hasSubscriptionUsage: input.models.some((model) => model.subscription),
		llmCalls: current.calls,
		models: [...input.models].sort(byTokens).slice(0, DIGEST_TOP_N),
		agents: [...input.agents].sort(byTokens).slice(0, DIGEST_TOP_N),
		runs: { ...runCounts, failureRate: failureRate(runCounts) },
		automations: {
			...automationTotals,
			items: [...input.automations]
				// Only automations that did something in this window; the previous window's
				// rows are here solely to judge whether a failure is new.
				.filter((automation) => automation.runs > 0)
				.sort((a, b) => b.failed - a.failed || b.costUsd - a.costUsd || b.runs - a.runs)
				.slice(0, DIGEST_TOP_N),
		},
		tools: {
			calls: input.tools.calls,
			failed: input.tools.failed,
			top: [...input.tools.top]
				.filter((tool) => tool.calls > 0)
				.sort((a, b) => b.calls - a.calls || b.costUsd - a.costUsd)
				.slice(0, DIGEST_TOP_N),
		},
		budget: { limits, tightest: limits[0] ?? null },
		inbox,
		anomalies: detectAnomalies(input),
	}
}

/* ── Markdown ───────────────────────────────────────────────────────────── */

function stamp(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * The digest as markdown, for the review inbox or a chat message.
 *
 * Numbers plus anomalies and nothing else. Kept well under the review inbox's 4,000-character
 * payload cap: every list is capped, and names are cut to one short line.
 */
export function renderDigestMarkdown(digest: UsageDigest): string {
	const lines: string[] = []
	const label = digestWindowLabel(digest.days)

	lines.push(`## Usage digest: last ${label}`)
	lines.push(`${stamp(digest.since)} to ${stamp(digest.until)} UTC`)
	lines.push('')

	lines.push('### Needs a look')
	if (digest.anomalies.length === 0) {
		lines.push('Nothing unusual.')
	} else {
		for (const anomaly of digest.anomalies.slice(0, DIGEST_MARKDOWN_MAX_ANOMALIES)) {
			lines.push(`- ${anomaly.severity === 'critical' ? '**Critical:** ' : ''}${anomaly.message}`)
		}
		const hidden = digest.anomalies.length - DIGEST_MARKDOWN_MAX_ANOMALIES
		if (hidden > 0) lines.push(`- …and ${hidden} more.`)
	}
	lines.push('')

	lines.push('### Numbers')
	const runs = digest.runs
	const rate = runs.failureRate === null ? '' : `, ${formatDigestPct(runs.failureRate)} failure rate`
	lines.push(`- **Runs:** ${runs.total} (${runs.failed} failed${rate})`)
	lines.push(
		`- **Tokens:** ${formatDigestTokens(digest.tokens.in)} in, ${formatDigestTokens(digest.tokens.out)} out, ` +
			`${formatDigestTokens(digest.tokens.cacheRead)} cache read (previous ${label}: ${formatDigestTokens(digest.tokens.previousTotal)} in + out)`,
	)
	lines.push(
		`- **Metered spend:** ${formatDigestUsd(digest.metered.usd)}` +
			(digest.hasSubscriptionUsage ? ' (Claude subscription runs are logged at $0)' : ''),
	)
	const automations = digest.automations
	lines.push(
		`- **Automations:** ${automations.runs} runs, ${automations.failed} failed` +
			(automations.blocked > 0 ? `, ${automations.blocked} blocked (a budget limit or a paused agent)` : '') +
			(automations.costUsd > 0 ? `, ${formatDigestUsd(automations.costUsd)} metered` : ''),
	)
	lines.push(`- **Tool calls:** ${digest.tools.calls} (${digest.tools.failed} failed)`)
	lines.push(
		`- **Review inbox:** ${digest.inbox.open} open (${digest.inbox.critical} critical, ${digest.inbox.warning} warning)`,
	)
	const tightest = digest.budget.tightest
	lines.push(
		`- **Budget:** ${
			tightest
				? `${describeLimit(tightest)} ${formatDigestPct(tightest.pct)} spent (${formatDigestUsd(tightest.spendUsd)} of ${formatDigestUsd(tightest.limitUsd)})`
				: 'No limits set'
		}`,
	)

	const list = <T>(title: string, rows: T[], describe: (row: T) => string) => {
		if (rows.length > 0) lines.push(`- **${title}:** ${rows.map(describe).join('; ')}`)
	}
	// Tokens, then metered dollars when there were any — for a gateway or OpenRouter model
	// the dollars are the number that matters.
	const usage = (row: { tokensIn: number; tokensOut: number; costUsd: number }) =>
		formatDigestTokens(row.tokensIn + row.tokensOut) + (row.costUsd > 0 ? ` (${formatDigestUsd(row.costUsd)})` : '')
	list('Top models', digest.models, (m) => `${oneLine(m.model, 48)} ${usage(m)}`)
	list('Top agents', digest.agents, (a) => `${oneLine(a.name ?? 'Deleted agent', 40)} ${usage(a)}`)
	list(
		'Busiest automations',
		automations.items,
		(a) =>
			`“${oneLine(a.description, 40)}” ${a.runs} run${a.runs === 1 ? '' : 's'}` +
			(a.failed > 0 ? `, ${a.failed} failed` : '') +
			(a.costUsd > 0 ? `, ${formatDigestUsd(a.costUsd)}` : ''),
	)
	list('Most-used tools', digest.tools.top, (t) => `${oneLine(t.toolName, 40)} ${t.calls}`)

	return lines.join('\n')
}
