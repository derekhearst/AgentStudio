import { expect, test } from '@playwright/test'
import {
	DEFAULT_TIMEZONE,
	computeNextRunAt,
	isValidTimeZone,
	parseCronExpression,
} from '../src/lib/automations/cron'

/**
 * Issue #30 — cron parser + time-zone-aware scheduling.
 *
 * Pure-function tests: `src/lib/automations/cron.ts` has no DB, no SvelteKit and no I/O, so
 * this spec runs without Postgres or a dev server (same arrangement as `aaak.unit.spec.ts`).
 *
 * What is pinned here:
 *   - real crontab lines resolve to the right *instant*, given a wall-clock zone
 *   - ranges / lists / steps / names / aliases / `?` / `7`-as-Sunday all parse
 *   - the Vixie day-of-month-OR-day-of-week rule, which is what makes `0 9 * * 1-5` work
 *   - every rejection names the offending field and says why
 *   - DST in America/Boise: the spring-forward hour is not silently skipped and the
 *     fall-back hour does not fire twice
 */

const TZ = 'America/Boise'
/** Monday 2026-09-21, 10:00 MDT. Fixed so the table below never drifts. */
const FROM = new Date('2026-09-21T16:00:00Z')

function nextIso(expression: string, from: Date = FROM, timeZone: string = TZ): string {
	return computeNextRunAt(expression, from, timeZone).toISOString()
}

/** Wall-clock reading of an instant in the schedule's zone, e.g. "2026-09-22 09:00". */
function wallClock(instant: Date, timeZone: string = TZ): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).formatToParts(instant)
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
	return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

test.describe('automations/cron — real crontab lines', () => {
	// Every row is a line someone could plausibly type. `expected` is the absolute instant;
	// `local` is the same moment read in America/Boise, so a wrong answer is obvious on sight.
	const SCHEDULES: Array<{ expression: string; expected: string; local: string; why: string }> = [
		{ expression: '* * * * *', expected: '2026-09-21T16:01:00.000Z', local: '2026-09-21 10:01', why: 'every minute' },
		{ expression: '*/15 * * * *', expected: '2026-09-21T16:15:00.000Z', local: '2026-09-21 10:15', why: 'step on wildcard' },
		{ expression: '5/20 * * * *', expected: '2026-09-21T16:05:00.000Z', local: '2026-09-21 10:05', why: 'step from a value to the field max' },
		{ expression: '0 * * * *', expected: '2026-09-21T17:00:00.000Z', local: '2026-09-21 11:00', why: 'top of every hour' },
		{ expression: '0 9 * * *', expected: '2026-09-22T15:00:00.000Z', local: '2026-09-22 09:00', why: 'daily at 9, the case the old UTC walk fired at 3am' },
		{ expression: '0 9 * * 1-5', expected: '2026-09-22T15:00:00.000Z', local: '2026-09-22 09:00', why: 'weekdays at 9 — the single most common real schedule' },
		{ expression: '0 9 * * MON-FRI', expected: '2026-09-22T15:00:00.000Z', local: '2026-09-22 09:00', why: 'same, written with day names' },
		{ expression: '30 9 * * 1,3,5', expected: '2026-09-23T15:30:00.000Z', local: '2026-09-23 09:30', why: 'day-of-week list' },
		{ expression: '0 9-17/4 * * *', expected: '2026-09-21T19:00:00.000Z', local: '2026-09-21 13:00', why: 'step on a range' },
		{ expression: '0 12 1,15 * *', expected: '2026-10-01T18:00:00.000Z', local: '2026-10-01 12:00', why: 'day-of-month list' },
		{ expression: '0 0 1 * *', expected: '2026-10-01T06:00:00.000Z', local: '2026-10-01 00:00', why: 'first of the month' },
		{ expression: '0 0 1 JAN *', expected: '2027-01-01T07:00:00.000Z', local: '2027-01-01 00:00', why: 'month name' },
		{ expression: '15 2 * FEB SUN', expected: '2027-02-07T09:15:00.000Z', local: '2027-02-07 02:15', why: 'month name + day name together' },
		{ expression: '0 9 * * 7', expected: '2026-09-27T15:00:00.000Z', local: '2026-09-27 09:00', why: '7 is Sunday' },
		{ expression: '0 9 ? * 2', expected: '2026-09-22T15:00:00.000Z', local: '2026-09-22 09:00', why: '? behaves as * in a day field' },
		{ expression: '0 22 15 * 5', expected: '2026-09-26T04:00:00.000Z', local: '2026-09-25 22:00', why: 'both day fields restricted — Vixie OR, so Friday wins over the 15th' },
		{ expression: '0 0 29 2 *', expected: '2028-02-29T07:00:00.000Z', local: '2028-02-29 00:00', why: 'leap day, more than a year out' },
		{ expression: '@hourly', expected: '2026-09-21T17:00:00.000Z', local: '2026-09-21 11:00', why: 'alias' },
		{ expression: '@daily', expected: '2026-09-22T06:00:00.000Z', local: '2026-09-22 00:00', why: 'alias' },
		{ expression: '@midnight', expected: '2026-09-22T06:00:00.000Z', local: '2026-09-22 00:00', why: 'alias' },
		{ expression: '@weekly', expected: '2026-09-27T06:00:00.000Z', local: '2026-09-27 00:00', why: 'alias — Sunday midnight, as in every other crontab' },
		{ expression: '@monthly', expected: '2026-10-01T06:00:00.000Z', local: '2026-10-01 00:00', why: 'alias' },
		{ expression: '@yearly', expected: '2027-01-01T07:00:00.000Z', local: '2027-01-01 00:00', why: 'alias' },
		{ expression: '@annually', expected: '2027-01-01T07:00:00.000Z', local: '2027-01-01 00:00', why: 'alias' },
		{ expression: '  0   9  *  *  1-5  ', expected: '2026-09-22T15:00:00.000Z', local: '2026-09-22 09:00', why: 'ragged whitespace collapses' },
		{ expression: '@DAILY', expected: '2026-09-22T06:00:00.000Z', local: '2026-09-22 00:00', why: 'aliases are case-insensitive' },
		{ expression: '0 9 * * mon-fri', expected: '2026-09-22T15:00:00.000Z', local: '2026-09-22 09:00', why: 'names are case-insensitive' },
	]

	for (const row of SCHEDULES) {
		test(`"${row.expression}" -> ${row.local} (${row.why})`, () => {
			const next = computeNextRunAt(row.expression, FROM, TZ)
			expect(next.toISOString()).toBe(row.expected)
			expect(wallClock(next)).toBe(row.local)
			expect(next.getTime()).toBeGreaterThan(FROM.getTime())
		})
	}

	test('weekday schedule rolls Friday evening over the weekend to Monday', () => {
		// 2026-09-18 is a Friday; 14:00 MDT is past the 9am fire.
		const fridayAfternoon = new Date('2026-09-18T20:00:00Z')
		const next = computeNextRunAt('0 9 * * 1-5', fridayAfternoon, TZ)
		expect(wallClock(next)).toBe('2026-09-21 09:00')
		expect(next.getUTCDay()).toBe(1)
	})
})

test.describe('automations/cron — parsing', () => {
	test('ranges, lists and steps expand to the right value sets', () => {
		const parsed = parseCronExpression('0,30 9-17/4 1,15 JAN-MAR MON-FRI')
		expect([...parsed.minutes]).toEqual([0, 30])
		expect([...parsed.hours]).toEqual([9, 13, 17])
		expect([...parsed.daysOfMonth]).toEqual([1, 15])
		expect([...parsed.months]).toEqual([1, 2, 3])
		expect([...parsed.daysOfWeek]).toEqual([1, 2, 3, 4, 5])
	})

	test('day-of-week 7 folds into 0 and 0-7 covers the whole week', () => {
		expect([...parseCronExpression('0 0 * * 7').daysOfWeek]).toEqual([0])
		expect([...parseCronExpression('0 0 * * 0-7').daysOfWeek].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
	})

	test('wildcard day fields are AND-ed, restricted day fields are OR-ed (Vixie rule)', () => {
		const weekdaysOnly = parseCronExpression('0 9 * * 1-5')
		expect(weekdaysOnly.dayOfMonthRestricted).toBe(false)
		expect(weekdaysOnly.dayOfWeekRestricted).toBe(true)

		const both = parseCronExpression('0 22 15 * 5')
		expect(both.dayOfMonthRestricted).toBe(true)
		expect(both.dayOfWeekRestricted).toBe(true)

		// `?` reads as a wildcard, so it must not flip the field into "restricted".
		expect(parseCronExpression('0 9 ? * 1-5').dayOfMonthRestricted).toBe(false)
	})

	test('aliases normalize to their five-field form', () => {
		expect(parseCronExpression('@hourly').normalized).toBe('0 * * * *')
		expect(parseCronExpression('@daily').normalized).toBe('0 0 * * *')
		expect(parseCronExpression('@weekly').normalized).toBe('0 0 * * 0')
		expect(parseCronExpression('@monthly').normalized).toBe('0 0 1 * *')
		expect(parseCronExpression('@yearly').normalized).toBe('0 0 1 1 *')
	})
})

test.describe('automations/cron — rejections name the field and the reason', () => {
	const REJECTIONS: Array<{ expression: string; matches: RegExp[] }> = [
		{ expression: '', matches: [/empty/i] },
		{ expression: '0 9 * *', matches: [/must have 5 fields/i, /got 4/] },
		{ expression: '0 0 9 * * *', matches: [/must have 5 fields/i, /seconds are not supported/i] },
		{ expression: '99 * * * *', matches: [/minute field "99"/, /out of range 0-59/] },
		{ expression: '0 25 * * *', matches: [/hour field "25"/, /out of range 0-23/] },
		{ expression: '0 9 32 * *', matches: [/day-of-month field "32"/, /out of range 1-31/] },
		{ expression: '0 9 * 13 *', matches: [/month field "13"/, /out of range 1-12/] },
		{ expression: '0 9 * * FUNDAY', matches: [/day-of-week field "FUNDAY"/, /unrecognized value "FUNDAY"/, /mon/] },
		{ expression: '0 9 * SMARCH *', matches: [/month field "SMARCH"/, /unrecognized value/] },
		{ expression: '0 9 * * 5-1', matches: [/day-of-week field "5-1"/, /range start 5 is after range end 1/] },
		{ expression: '*/0 * * * *', matches: [/minute field "\*\/0"/, /step "0" must be a positive integer/] },
		{ expression: '*/abc * * * *', matches: [/minute field/, /step "abc" must be a positive integer/] },
		{ expression: '0 9 * * 1,,5', matches: [/day-of-week field/, /stray comma/] },
		{ expression: '0 9 1-2-3 * *', matches: [/day-of-month field/, /not a valid range/] },
		{ expression: '*/2/3 * * * *', matches: [/minute field/, /more than one "\/" step/] },
		{ expression: '0 9 * * L', matches: [/day-of-week field "L"/, /unrecognized value "L"/] },
		{ expression: '? 9 * * *', matches: [/minute field/, /only allowed in the day-of-month and day-of-week/] },
		{ expression: '@reboot', matches: [/@reboot/, /not supported/i, /no boot event/i] },
		{ expression: '@fortnightly', matches: [/Unknown cron alias/, /@monthly/] },
	]

	for (const row of REJECTIONS) {
		test(`rejects "${row.expression || '(empty)'}"`, () => {
			let thrown: unknown
			try {
				computeNextRunAt(row.expression, FROM, TZ)
			} catch (error) {
				thrown = error
			}
			expect(thrown, `expected "${row.expression}" to be rejected`).toBeInstanceOf(Error)
			for (const matcher of row.matches) expect((thrown as Error).message).toMatch(matcher)
		})
	}

	test('an expression that parses but can never match is reported, not looped on', () => {
		// February 30th.
		expect(() => computeNextRunAt('0 0 30 2 *', FROM, TZ)).toThrow(/no run time within the next four years/)
	})

	test('an unknown time zone is rejected by name', () => {
		expect(() => computeNextRunAt('0 9 * * *', FROM, 'Mars/Olympus_Mons')).toThrow(/Unknown time zone/)
		expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
		expect(isValidTimeZone('America/Boise')).toBe(true)
		expect(isValidTimeZone('UTC')).toBe(true)
	})
})

test.describe('automations/cron — time zones', () => {
	test('the same expression resolves to a different instant per zone', () => {
		expect(nextIso('0 9 * * *', FROM, 'America/Boise')).toBe('2026-09-22T15:00:00.000Z')
		expect(nextIso('0 9 * * *', FROM, 'UTC')).toBe('2026-09-22T09:00:00.000Z')
		expect(nextIso('0 9 * * *', FROM, 'Australia/Sydney')).toBe('2026-09-21T23:00:00.000Z')
	})

	test('the default zone is America/Boise, not the process clock', () => {
		expect(DEFAULT_TIMEZONE).toBe('America/Boise')
		expect(nextIso('0 9 * * *', FROM)).toBe(nextIso('0 9 * * *', FROM, 'America/Boise'))
	})

	test('a 9am schedule is 9am local in every month, not shifted by DST', () => {
		// Same wall clock either side of both transitions, even though the UTC offset differs.
		expect(wallClock(computeNextRunAt('0 9 * * *', new Date('2026-01-15T00:00:00Z'), TZ))).toBe('2026-01-15 09:00')
		expect(wallClock(computeNextRunAt('0 9 * * *', new Date('2026-07-15T00:00:00Z'), TZ))).toBe('2026-07-15 09:00')
		expect(computeNextRunAt('0 9 * * *', new Date('2026-01-15T00:00:00Z'), TZ).toISOString()).toBe(
			'2026-01-15T16:00:00.000Z', // MST, UTC-7
		)
		expect(computeNextRunAt('0 9 * * *', new Date('2026-07-15T00:00:00Z'), TZ).toISOString()).toBe(
			'2026-07-15T15:00:00.000Z', // MDT, UTC-6
		)
	})
})

/**
 * Walk a schedule forward the way the engine does — each run's `nextRunAt` becomes the next
 * call's `from` — and collect every fire strictly inside the window.
 */
function walkSchedule(expression: string, startIso: string, endIso: string, timeZone = TZ): Date[] {
	const end = new Date(endIso).getTime()
	const fires: Date[] = []
	let cursor = new Date(startIso)
	for (let guard = 0; guard < 500; guard++) {
		const next = computeNextRunAt(expression, cursor, timeZone)
		expect(next.getTime()).toBeGreaterThan(cursor.getTime()) // never stalls or goes backwards
		if (next.getTime() >= end) break
		fires.push(next)
		cursor = next
	}
	return fires
}

test.describe('automations/cron — DST in America/Boise', () => {
	// 2026: clocks jump forward 2026-03-08 02:00 -> 03:00, and back 2026-11-01 02:00 -> 01:00.

	test('spring forward: an hourly schedule fires 23 times on the 23-hour day, one per wall-clock hour', () => {
		// Local midnight 2026-03-08 is 07:00Z (MST); local midnight 2026-03-09 is 06:00Z (MDT).
		const fires = walkSchedule('0 * * * *', '2026-03-08T06:59:00Z', '2026-03-09T06:00:00Z')
		expect(fires).toHaveLength(23)
		const hours = fires.map((fire) => wallClock(fire).slice(11, 13))
		expect(new Set(hours).size).toBe(23)
		// 02:00 does not exist that day; 01:00 and 03:00 are an hour apart in real time.
		expect(hours).not.toContain('02')
		expect(fires[1].toISOString()).toBe('2026-03-08T08:00:00.000Z') // 01:00 MST
		expect(fires[2].toISOString()).toBe('2026-03-08T09:00:00.000Z') // 03:00 MDT
	})

	test('spring forward: a schedule inside the lost hour still fires once, at the jump', () => {
		// The old local-getter walk skipped the day entirely for these.
		const twoAm = computeNextRunAt('0 2 * * *', new Date('2026-03-08T05:00:00Z'), TZ)
		expect(twoAm.toISOString()).toBe('2026-03-08T09:00:00.000Z')
		expect(wallClock(twoAm)).toBe('2026-03-08 03:00')

		const halfPastTwo = computeNextRunAt('30 2 * * *', new Date('2026-03-08T05:00:00Z'), TZ)
		expect(halfPastTwo.toISOString()).toBe('2026-03-08T09:00:00.000Z')

		// And the day after, it is back to a normal 02:00 local.
		expect(wallClock(computeNextRunAt('0 2 * * *', twoAm, TZ))).toBe('2026-03-09 02:00')
	})

	test('fall back: an hourly schedule fires 24 times across the 25-hour day, never twice at the same wall clock', () => {
		// Local midnight 2026-11-01 is 06:00Z (MDT); local midnight 2026-11-02 is 07:00Z (MST).
		const fires = walkSchedule('0 * * * *', '2026-11-01T05:59:00Z', '2026-11-02T07:00:00Z')
		expect(fires).toHaveLength(24)
		const stamps = fires.map((fire) => wallClock(fire))
		expect(new Set(stamps).size).toBe(24)
		// 01:00 happens twice in real time; only the first pass (MDT) fires.
		expect(fires[1].toISOString()).toBe('2026-11-01T07:00:00.000Z') // 01:00 MDT
		expect(fires[2].toISOString()).toBe('2026-11-01T09:00:00.000Z') // 02:00 MST
	})

	test('fall back: a schedule inside the repeated hour fires once, on the first pass', () => {
		const fires = walkSchedule('30 1 * * *', '2026-10-31T20:00:00Z', '2026-11-03T00:00:00Z')
		expect(fires.map((fire) => fire.toISOString())).toEqual([
			'2026-11-01T07:30:00.000Z', // 01:30 MDT — the first 1:30am of the day
			'2026-11-02T08:30:00.000Z', // 01:30 MST the next day
		])
		// The repeated 01:30 (08:30Z) is deliberately absent: one wall-clock time, one run.
		expect(fires.map((fire) => fire.toISOString())).not.toContain('2026-11-01T08:30:00.000Z')
	})

	test('daily schedules keep their wall-clock time across both transitions', () => {
		const spring = walkSchedule('0 9 * * *', '2026-03-07T07:00:00Z', '2026-03-10T07:00:00Z')
		expect(spring.map((fire) => wallClock(fire))).toEqual([
			'2026-03-07 09:00',
			'2026-03-08 09:00',
			'2026-03-09 09:00',
		])

		const fall = walkSchedule('0 9 * * *', '2026-10-31T06:00:00Z', '2026-11-03T07:00:00Z')
		expect(fall.map((fire) => wallClock(fire))).toEqual([
			'2026-10-31 09:00',
			'2026-11-01 09:00',
			'2026-11-02 09:00',
		])
	})

	test('a zone without DST is unaffected by either transition', () => {
		const fires = walkSchedule('0 * * * *', '2026-11-01T05:59:00Z', '2026-11-02T06:00:00Z', 'UTC')
		expect(fires).toHaveLength(24)
		expect(fires[0].toISOString()).toBe('2026-11-01T06:00:00.000Z')
	})
})
