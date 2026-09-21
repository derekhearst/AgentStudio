/**
 * Cron-expression parser + next-run calculator used by automations.
 *
 * Supported syntax (standard 5-field crontab: minute hour day-of-month month day-of-week):
 *   - `*`                      — every value in range
 *   - `5`                      — a literal
 *   - `1-5`                    — an inclusive range
 *   - `1,3,5`                  — a list (each element may itself be a range/step)
 *   - `*\/15`, `1-5/2`, `5/15` — a step over `*`, over a range, or from a value to the field max
 *   - `MON`, `jan`             — three-letter day-of-week / month names (case-insensitive)
 *   - `?`                      — synonym for `*`, day-of-month and day-of-week only
 *   - `7`                      — Sunday, in day-of-week (normalised to 0)
 *   - aliases: `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`
 *
 * Deliberately unsupported: `@reboot` (there is no boot event to hang a schedule on), and
 * the Quartz `L` / `W` / `#` modifiers. Every rejection throws an Error naming the offending
 * field and the reason, so the UI can show something better than "unschedulable".
 *
 * Day-of-month vs day-of-week follows the Vixie rule: when *both* are restricted the job runs
 * when *either* matches; when one is `*` the two are ANDed. That is what makes `0 9 * * 1-5`
 * mean "weekdays at 9" rather than "never".
 *
 * ── Time zones ───────────────────────────────────────────────────────────────
 * A cron expression is a *wall-clock* schedule, so it is meaningless without a zone. The
 * previous implementation walked `new Date()` local getters; the production container sets no
 * TZ, so "local" was UTC and a `0 9 * * *` automation fired at 3am Boise time. `computeNextRunAt`
 * now takes an IANA zone (defaulting to `DEFAULT_TIMEZONE`) and does the walk in that zone's
 * wall clock, converting the match back to an absolute instant at the end.
 *
 * DST is handled with fixed-wall-clock semantics:
 *   - Spring forward: a schedule that lands in the nonexistent hour fires once, at the instant
 *     the clock jumps (e.g. `0 2 * * *` fires at 03:00 local on the transition day) instead of
 *     being silently skipped for the day.
 *   - Fall back: a schedule inside the repeated hour fires once, on the *first* pass through
 *     that wall-clock time, instead of double-firing an hour later.
 *
 * Pure module — no DB, no SvelteKit, no I/O — so it unit-tests without a database.
 */

/** Zone every automation gets unless it says otherwise. The NAS and its operator live here. */
export const DEFAULT_TIMEZONE = 'America/Boise'

/** Offered in the create form's zone picker. Free-text IANA zones are still accepted. */
export const COMMON_TIME_ZONES = [
	'America/Boise',
	'America/Los_Angeles',
	'America/Denver',
	'America/Chicago',
	'America/New_York',
	'America/Anchorage',
	'Pacific/Honolulu',
	'UTC',
	'Europe/London',
	'Europe/Berlin',
	'Asia/Tokyo',
	'Australia/Sydney',
] as const

const MS_MINUTE = 60_000
const MS_HOUR = 3_600_000
const MS_DAY = 86_400_000

const MONTH_NAMES: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
}

const DAY_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
}

interface FieldSpec {
	/** Human name used in error messages — matches the crontab column name. */
	name: string
	min: number
	max: number
	/** Range as shown to the user; day-of-week accepts 0-7 but only means 0-6. */
	rangeLabel: string
	names?: Record<string, number>
	/** `?` is accepted as a `*` synonym in the two day fields only. */
	allowQuestionMark?: boolean
}

const MINUTE_SPEC: FieldSpec = { name: 'minute', min: 0, max: 59, rangeLabel: '0-59' }
const HOUR_SPEC: FieldSpec = { name: 'hour', min: 0, max: 23, rangeLabel: '0-23' }
const DOM_SPEC: FieldSpec = {
	name: 'day-of-month',
	min: 1,
	max: 31,
	rangeLabel: '1-31',
	allowQuestionMark: true,
}
const MONTH_SPEC: FieldSpec = {
	name: 'month',
	min: 1,
	max: 12,
	rangeLabel: '1-12',
	names: MONTH_NAMES,
}
const DOW_SPEC: FieldSpec = {
	name: 'day-of-week',
	min: 0,
	max: 7,
	rangeLabel: '0-7 (0 and 7 are both Sunday)',
	names: DAY_NAMES,
	allowQuestionMark: true,
}

export interface ParsedCron {
	/** The expression after alias expansion and whitespace collapse. */
	normalized: string
	minutes: Set<number>
	hours: Set<number>
	daysOfMonth: Set<number>
	months: Set<number>
	/** 0-6, Sunday first. A `7` in the source is folded into `0`. */
	daysOfWeek: Set<number>
	/** False when the field was `*` / `?` — drives the Vixie OR rule. */
	dayOfMonthRestricted: boolean
	dayOfWeekRestricted: boolean
}

function fieldError(spec: FieldSpec, raw: string, reason: string): Error {
	return new Error(`Invalid cron ${spec.name} field "${raw}": ${reason}`)
}

function parseValue(spec: FieldSpec, raw: string, token: string): number {
	const trimmed = token.trim()
	if (trimmed === '') throw fieldError(spec, raw, 'empty value')

	if (/^\d+$/.test(trimmed)) {
		const value = Number(trimmed)
		if (value < spec.min || value > spec.max) {
			throw fieldError(spec, raw, `value ${value} is out of range ${spec.rangeLabel}`)
		}
		return value
	}

	const named = spec.names?.[trimmed.toLowerCase()]
	if (named !== undefined) return named

	const hint = spec.names
		? ` — expected a number in ${spec.rangeLabel} or a three-letter name (${Object.keys(spec.names).join(', ')})`
		: ` — expected a number in ${spec.rangeLabel}`
	throw fieldError(spec, raw, `unrecognized value "${trimmed}"${hint}`)
}

/**
 * Expand one crontab field into the set of values it matches.
 * Returns `wildcard: true` only for a bare `*` / `?`, which the day-field OR rule needs.
 */
function parseField(spec: FieldSpec, raw: string): { values: Set<number>; wildcard: boolean } {
	const field = raw.trim()
	if (field === '') throw fieldError(spec, raw, 'field is empty')

	if (field === '?' && !spec.allowQuestionMark) {
		throw fieldError(spec, raw, '"?" is only allowed in the day-of-month and day-of-week fields')
	}

	const wildcard = field === '*' || (field === '?' && spec.allowQuestionMark === true)
	const values = new Set<number>()

	for (const element of field.split(',')) {
		const part = element.trim()
		if (part === '') throw fieldError(spec, raw, 'empty list element (stray comma)')

		const slashPieces = part.split('/')
		if (slashPieces.length > 2) {
			throw fieldError(spec, raw, `"${part}" has more than one "/" step`)
		}

		let step = 1
		if (slashPieces.length === 2) {
			const stepToken = slashPieces[1].trim()
			if (!/^\d+$/.test(stepToken) || Number(stepToken) === 0) {
				throw fieldError(spec, raw, `step "${stepToken}" must be a positive integer`)
			}
			step = Number(stepToken)
		}

		const base = slashPieces[0].trim()
		let start: number
		let end: number

		if (base === '*' || (base === '?' && spec.allowQuestionMark)) {
			start = spec.min
			end = spec.max
		} else if (base.includes('-')) {
			const bounds = base.split('-')
			if (bounds.length !== 2) throw fieldError(spec, raw, `"${base}" is not a valid range`)
			start = parseValue(spec, raw, bounds[0])
			end = parseValue(spec, raw, bounds[1])
			if (start > end) {
				throw fieldError(
					spec,
					raw,
					`range start ${bounds[0].trim()} is after range end ${bounds[1].trim()} — wrapping ranges are not supported, use a list instead`,
				)
			}
		} else {
			start = parseValue(spec, raw, base)
			// `5/15` is crontab shorthand for "from 5 to the field max, every 15".
			end = slashPieces.length === 2 ? spec.max : start
		}

		for (let value = start; value <= end; value += step) values.add(value)
	}

	if (values.size === 0) throw fieldError(spec, raw, 'matches no values')
	return { values, wildcard }
}

/** Expand `@hourly` and friends. Rejects `@reboot` explicitly rather than falling through. */
function normalizeCronExpression(cronExpression: string): string {
	const normalized = cronExpression.trim().replace(/\s+/g, ' ')
	if (!normalized.startsWith('@')) return normalized

	switch (normalized.toLowerCase()) {
		case '@yearly':
		case '@annually':
			return '0 0 1 1 *'
		case '@monthly':
			return '0 0 1 * *'
		// Standard crontab @weekly is Sunday midnight. (An earlier version of this module
		// expanded it to Monday, which matched no other cron implementation on earth.)
		case '@weekly':
			return '0 0 * * 0'
		case '@daily':
		case '@midnight':
			return '0 0 * * *'
		case '@hourly':
			return '0 * * * *'
		case '@reboot':
			throw new Error(
				'Cron alias "@reboot" is not supported — automations have no boot event. Use an explicit schedule such as "0 9 * * *".',
			)
		default:
			throw new Error(
				`Unknown cron alias "${normalized}" — supported aliases are @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly.`,
			)
	}
}

/**
 * Parse a crontab line into matchable value sets. Throws an Error naming the field and the
 * reason on anything it cannot read. Exported so callers can validate without scheduling.
 */
export function parseCronExpression(cronExpression: string): ParsedCron {
	if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
		throw new Error('Cron expression is empty')
	}

	const normalized = normalizeCronExpression(cronExpression)
	const parts = normalized.split(' ')
	if (parts.length !== 5) {
		const extra =
			parts.length === 6
				? ' (6 fields looks like a seconds-precision expression; seconds are not supported)'
				: ''
		throw new Error(
			`Cron expression must have 5 fields (minute hour day-of-month month day-of-week) but got ${parts.length} in "${normalized}"${extra}`,
		)
	}

	const [minuteField, hourField, domField, monthField, dowField] = parts
	const minute = parseField(MINUTE_SPEC, minuteField)
	const hour = parseField(HOUR_SPEC, hourField)
	const dom = parseField(DOM_SPEC, domField)
	const month = parseField(MONTH_SPEC, monthField)
	const dow = parseField(DOW_SPEC, dowField)

	// 7 is a legal alias for Sunday; fold it so the matcher only ever sees 0-6.
	const daysOfWeek = new Set<number>()
	for (const value of dow.values) daysOfWeek.add(value === 7 ? 0 : value)

	return {
		normalized,
		minutes: minute.values,
		hours: hour.values,
		daysOfMonth: dom.values,
		months: month.values,
		daysOfWeek,
		dayOfMonthRestricted: !dom.wildcard,
		dayOfWeekRestricted: !dow.wildcard,
	}
}

// ─────────────────────────── time-zone plumbing ───────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = formatterCache.get(timeZone)
	if (cached) return cached
	let formatter: Intl.DateTimeFormat
	try {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		})
	} catch {
		throw new Error(`Unknown time zone "${timeZone}" — use an IANA zone name such as "America/Boise".`)
	}
	formatterCache.set(timeZone, formatter)
	return formatter
}

/** True when the string is an IANA zone this runtime can resolve. */
export function isValidTimeZone(timeZone: string): boolean {
	try {
		getFormatter(timeZone)
		return true
	} catch {
		return false
	}
}

/**
 * The wall-clock reading in `timeZone` at `instant`, expressed as a "naive" epoch value
 * (the same y/m/d h:m:s reinterpreted as if it were UTC). All the walking below happens in
 * this naive space, which is what makes plain date arithmetic safe.
 */
function toNaive(instant: number, timeZone: string): number {
	const parts = getFormatter(timeZone).formatToParts(new Date(instant))
	let year = 0
	let month = 1
	let day = 1
	let hour = 0
	let minute = 0
	let second = 0
	for (const part of parts) {
		switch (part.type) {
			case 'year':
				year = Number(part.value)
				break
			case 'month':
				month = Number(part.value)
				break
			case 'day':
				day = Number(part.value)
				break
			case 'hour':
				// Some ICU builds render midnight as 24 under h23 edge cases.
				hour = Number(part.value) % 24
				break
			case 'minute':
				minute = Number(part.value)
				break
			case 'second':
				second = Number(part.value)
				break
		}
	}
	return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** Zone offset in ms at `instant` (naive wall clock minus true UTC). MST is -7h. */
function offsetAt(instant: number, timeZone: string): number {
	return toNaive(instant, timeZone) - Math.floor(instant / 1000) * 1000
}

/**
 * Resolve a naive wall-clock value back to real instants.
 *
 * Normal times resolve to exactly one instant. A time inside the fall-back repeat resolves to
 * two (we take the earlier). A time inside the spring-forward gap resolves to none, and we
 * return the transition instant instead so the schedule fires once, right as the clock jumps.
 */
function resolveNaive(naive: number, timeZone: string): { instant: number; gap: boolean } {
	const beforeOffset = offsetAt(naive - MS_DAY, timeZone)
	const afterOffset = offsetAt(naive + MS_DAY, timeZone)
	const candidateA = naive - beforeOffset
	const candidateB = naive - afterOffset

	const valid: number[] = []
	if (offsetAt(candidateA, timeZone) === beforeOffset) valid.push(candidateA)
	if (candidateB !== candidateA && offsetAt(candidateB, timeZone) === afterOffset) valid.push(candidateB)

	if (valid.length > 0) return { instant: Math.min(...valid), gap: false }

	// Nonexistent wall-clock time: binary-search the offset transition that swallowed it.
	let low = Math.min(candidateA, candidateB)
	let high = Math.max(candidateA, candidateB)
	const lowOffset = offsetAt(low, timeZone)
	while (high - low > MS_MINUTE) {
		const mid = low + Math.round((high - low) / 2 / MS_MINUTE) * MS_MINUTE
		if (mid <= low || mid >= high) break
		if (offsetAt(mid, timeZone) === lowOffset) low = mid
		else high = mid
	}
	return { instant: high, gap: true }
}

function matchesDate(parsed: ParsedCron, naive: number): boolean {
	const date = new Date(naive)
	if (!parsed.months.has(date.getUTCMonth() + 1)) return false

	const dayOfMonth = date.getUTCDate()
	const dayOfWeek = date.getUTCDay()
	if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) {
		// Vixie rule: both restricted means "either one matches".
		return parsed.daysOfMonth.has(dayOfMonth) || parsed.daysOfWeek.has(dayOfWeek)
	}
	return parsed.daysOfMonth.has(dayOfMonth) && parsed.daysOfWeek.has(dayOfWeek)
}

/**
 * The next instant strictly after `from` at which `cronExpression` fires, read as wall-clock
 * time in `timeZone`.
 *
 * Throws a field-specific Error for an unparseable expression, and a bounded-search Error for
 * an expression that parses but can never match (e.g. `0 0 30 2 *` — February 30th).
 */
export function computeNextRunAt(
	cronExpression: string,
	from: Date = new Date(),
	timeZone: string = DEFAULT_TIMEZONE,
): Date {
	const parsed = parseCronExpression(cronExpression)
	getFormatter(timeZone) // validates the zone up front
	const fromMs = from.getTime()
	if (!Number.isFinite(fromMs)) throw new Error('Cron start time is an invalid Date')

	// Walk the target zone's wall clock, minute by minute, starting at the next whole minute.
	let cursor = Math.floor(toNaive(fromMs, timeZone) / MS_MINUTE) * MS_MINUTE + MS_MINUTE
	// Four years + a day, so a legitimate `0 0 29 2 *` still resolves; days that can't match
	// are skipped wholesale, so the bound costs a few thousand cheap date comparisons.
	const limit = cursor + 1462 * MS_DAY

	while (cursor < limit) {
		if (!matchesDate(parsed, cursor)) {
			const date = new Date(cursor)
			cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
			continue
		}
		const date = new Date(cursor)
		if (!parsed.hours.has(date.getUTCHours())) {
			cursor = Math.floor(cursor / MS_HOUR) * MS_HOUR + MS_HOUR
			continue
		}
		if (!parsed.minutes.has(date.getUTCMinutes())) {
			cursor += MS_MINUTE
			continue
		}

		const { instant } = resolveNaive(cursor, timeZone)
		// An ambiguous (repeated) wall-clock time can resolve to an instant at or before
		// `from`; skipping it is what stops the fall-back hour from firing twice.
		if (instant > fromMs) return new Date(instant)
		cursor += MS_MINUTE
	}

	throw new Error(
		`Cron expression "${parsed.normalized}" has no run time within the next four years in time zone ${timeZone}`,
	)
}
