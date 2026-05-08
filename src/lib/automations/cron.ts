/**
 * Minimal cron-expression parser used by automations to compute the next run time.
 *
 * Supports:
 *   - `*` — any value in range
 *   - `*\/N` — every N (e.g. `*\/5` for every 5 minutes)
 *   - integer literals
 *   - the `@hourly`, `@daily`, `@weekly` aliases
 *
 * Pure module — exported for unit-testing without spinning up the engine. The
 * `computeNextRunAt` function does the day-by-minute walk to find the next
 * matching wall-clock time; bounded at one year of search to surface
 * unschedulable expressions instead of looping forever.
 */

function parseField(field: string, min: number, max: number): number[] {
	if (field === '*') {
		const values: number[] = []
		for (let value = min; value <= max; value++) values.push(value)
		return values
	}

	if (/^\*\/[0-9]+$/.test(field)) {
		const step = Number(field.split('/')[1])
		if (!Number.isInteger(step) || step <= 0) return []
		const values: number[] = []
		for (let value = min; value <= max; value += step) values.push(value)
		return values
	}

	const parsed = Number(field)
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) return []
	return [parsed]
}

function normalizeCronExpression(cronExpression: string): string {
	const normalized = cronExpression.trim().replace(/\s+/g, ' ')
	if (normalized === '@hourly') return '0 * * * *'
	if (normalized === '@daily') return '0 0 * * *'
	if (normalized === '@weekly') return '0 0 * * 1'
	return normalized
}

export function computeNextRunAt(cronExpression: string, from = new Date()): Date {
	const normalized = normalizeCronExpression(cronExpression)
	const parts = normalized.split(' ')
	if (parts.length !== 5) {
		throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week')
	}

	const [minuteField, hourField, dayField, monthField, weekDayField] = parts
	const minutes = parseField(minuteField, 0, 59)
	const hours = parseField(hourField, 0, 23)
	const days = parseField(dayField, 1, 31)
	const months = parseField(monthField, 1, 12)
	const weekDays = parseField(weekDayField, 0, 6)
	if (
		minutes.length === 0 ||
		hours.length === 0 ||
		days.length === 0 ||
		months.length === 0 ||
		weekDays.length === 0
	) {
		throw new Error('Cron expression contains unsupported values')
	}

	const cursor = new Date(from)
	cursor.setSeconds(0, 0)
	cursor.setMinutes(cursor.getMinutes() + 1)

	for (let i = 0; i < 366 * 24 * 60; i++) {
		const minute = cursor.getMinutes()
		const hour = cursor.getHours()
		const day = cursor.getDate()
		const month = cursor.getMonth() + 1
		const weekDay = cursor.getDay()

		if (
			minutes.includes(minute) &&
			hours.includes(hour) &&
			days.includes(day) &&
			months.includes(month) &&
			weekDays.includes(weekDay)
		) {
			return new Date(cursor)
		}

		cursor.setMinutes(cursor.getMinutes() + 1)
	}

	throw new Error('Unable to compute next run time from cron expression')
}
