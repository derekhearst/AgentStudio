/**
 * Date / relative-time formatting helpers used by the automations page.
 *
 * Pure functions — no I/O, no dependencies — so they live in the domain barrel
 * rather than the page component. Reusable by any future surface that lists
 * automation rows (sub-pages, dashboards, embedded widgets).
 */

export function toTime(value: Date | string | null): number {
	if (!value) return 0
	const date = typeof value === 'string' ? new Date(value) : value
	const time = date.getTime()
	return Number.isNaN(time) ? 0 : time
}

export function formatDate(value: Date | string | null): string {
	if (!value) return 'Unscheduled'
	const date = typeof value === 'string' ? new Date(value) : value
	return date.toLocaleString()
}

// Bidirectional variant ("in Xm" for future runs, "Xm ago" for past) — automations show
// both lastRunAt and nextRunAt in the same UI strip.
export { relativeTimeBidirectional as relativeTime } from '$lib/util/relative-time'

/** True when `value` is in the future and within the next hour. */
export function isDueSoon(value: Date | string | null): boolean {
	if (!value) return false
	const ms = toTime(value)
	if (ms === 0) return false
	const diff = ms - Date.now()
	return diff >= 0 && diff <= 3_600_000
}
