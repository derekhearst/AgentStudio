/**
 * Shared "X ago" relative-time formatter.
 *
 * Replaces 9 near-duplicate implementations across the codebase. Style options
 * cover the existing UX variants:
 *   - 'lowercase' (default): "just now", "5m ago", "3h ago", "2d ago"
 *   - 'capitalized':         "Just now", "5m ago", "3h ago", "2d ago"
 *
 * `nullLabel` controls the empty/null fallback ("Never" / "never" / "—").
 * `weekFallback` extends the day-bucket beyond 7 days into an ISO-date string
 * — the memory views use this to keep older drawers readable.
 */

export type RelativeTimeStyle = 'lowercase' | 'capitalized'

export type RelativeTimeOptions = {
	style?: RelativeTimeStyle
	nullLabel?: string
	/** When true, dates older than 7d render as `YYYY-MM-DD` instead of `Nd ago`. */
	weekFallback?: boolean
	/** When true, drops the " ago" suffix. "1m" / "1h" / "1d" instead of "1m ago" etc. */
	compact?: boolean
}

const JUST_NOW = { lowercase: 'just now', capitalized: 'Just now' } as const

export function relativeTime(
	value: Date | string | null | undefined,
	options: RelativeTimeOptions = {},
): string {
	const style = options.style ?? 'lowercase'
	const nullLabel = options.nullLabel ?? (style === 'capitalized' ? 'Never' : 'never')
	const suffix = options.compact ? '' : ' ago'
	if (!value) return nullLabel
	const date = typeof value === 'string' ? new Date(value) : value
	const diff = Date.now() - date.getTime()
	if (Number.isNaN(diff)) return nullLabel
	if (diff < 60_000) return JUST_NOW[style]
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m${suffix}`
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h${suffix}`
	if (options.weekFallback && diff >= 7 * 86_400_000) {
		return date.toISOString().slice(0, 10)
	}
	return `${Math.floor(diff / 86_400_000)}d${suffix}`
}

/**
 * Format a date+time as a locale string. Returns `'—'` for nullish input so
 * UI columns stay populated even when a row hasn't reached the relevant phase
 * (e.g. `startedAt` for a queued job, `finishedAt` for a running job).
 */
export function formatDateTime(value: Date | string | null | undefined): string {
	if (!value) return '—'
	return new Date(value).toLocaleString()
}

/**
 * Bidirectional variant: supports future dates with "in Xm" / "in Xh" / "in Xd"
 * formatting. Used by the automations page to show next-run times alongside
 * last-run times.
 */
export function relativeTimeBidirectional(value: Date | string | null | undefined): string {
	if (!value) return 'Never'
	const date = typeof value === 'string' ? new Date(value) : value
	const diffMs = Date.now() - date.getTime()
	if (Number.isNaN(diffMs)) return 'Unknown'
	if (Math.abs(diffMs) < 60_000) return 'Just now'
	const minutes = Math.round(diffMs / 60_000)
	if (Math.abs(minutes) < 60) return minutes > 0 ? `${minutes}m ago` : `in ${Math.abs(minutes)}m`
	const hours = Math.round(minutes / 60)
	if (Math.abs(hours) < 24) return hours > 0 ? `${hours}h ago` : `in ${Math.abs(hours)}h`
	const days = Math.round(hours / 24)
	return days > 0 ? `${days}d ago` : `in ${Math.abs(days)}d`
}
