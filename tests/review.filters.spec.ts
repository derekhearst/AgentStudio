import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * The inbox's type filter accepts every review item type the database has.
 *
 * The list was a hand-kept copy that missed `pull_request_checks_failed`: choosing "PR
 * checks failed" in /review failed validation, and the page went on showing the previous
 * filter's items under the new label. Both the server's schema and the page's labels now
 * come from the enum.
 *
 * The "Open queue" status took only a limit, so it ignored the type and severity filters
 * and listed every open item whichever one was picked.
 */

test.describe('review/filters — every item type is filterable', () => {
	test('the list schema accepts every review_item_type, including PR checks failed', async () => {
		const { reviewItemListSchema } = await import('../src/lib/observability/review-filters')
		const { reviewItemTypeEnum } = await import('../src/lib/observability/observability.schema')
		for (const type of reviewItemTypeEnum.enumValues) {
			expect(reviewItemListSchema.safeParse({ type }).success, type).toBe(true)
		}
		expect(reviewItemListSchema.parse({ type: 'pull_request_checks_failed' }).type).toBe('pull_request_checks_failed')
		expect(reviewItemListSchema.safeParse({ type: 'not_a_type' }).success).toBe(false)
	})

	test('the inbox has a label for every review_item_type', async () => {
		const { REVIEW_ITEM_TYPE_LABELS } = await import('../src/lib/observability/review-item-labels')
		const { reviewItemTypeEnum } = await import('../src/lib/observability/observability.schema')
		expect(Object.keys(REVIEW_ITEM_TYPE_LABELS).sort()).toEqual([...reviewItemTypeEnum.enumValues].sort())
		expect(REVIEW_ITEM_TYPE_LABELS.pull_request_checks_failed).toBe('PR checks failed')
	})

	test('the open queue honours the type and severity filters', async () => {
		const sql = getSql()
		const prefix = uniquePrefix('review-open-filters')
		const seed = async (type: string, severity: string, status: string, label: string) => {
			const [row] = await sql<{ id: string }[]>`
				insert into review_items (type, severity, status, summary, payload)
				values (
					${type}::review_item_type, ${severity}::review_item_severity,
					${status}::review_item_status, ${`${prefix} ${label}`}, ${sql.json({})}
				)
				returning id
			`
			return row.id
		}
		try {
			const ciOpen = await seed('pull_request_checks_failed', 'warning', 'open', 'ci open')
			const ciCritical = await seed('pull_request_checks_failed', 'critical', 'in_progress', 'ci critical')
			const ciResolved = await seed('pull_request_checks_failed', 'critical', 'resolved', 'ci resolved')
			const summary = await seed('automation_summary', 'info', 'open', 'summary')

			const { listOpenReviewItems } = await import('../src/lib/observability/review.server')
			const mine = (rows: { id: string }[]) =>
				rows.map((row) => row.id).filter((id) => [ciOpen, ciCritical, ciResolved, summary].includes(id))

			const byType = await listOpenReviewItems({ type: 'pull_request_checks_failed' })
			expect(byType.every((row) => row.type === 'pull_request_checks_failed')).toBe(true)
			expect(mine(byType).sort()).toEqual([ciOpen, ciCritical].sort())

			const bySeverity = await listOpenReviewItems({ severity: 'critical' })
			expect(bySeverity.every((row) => row.severity === 'critical')).toBe(true)
			expect(mine(bySeverity)).toEqual([ciCritical])

			const otherType = await listOpenReviewItems({ type: 'automation_summary' })
			expect(mine(otherType)).toEqual([summary])
		} finally {
			await sql`delete from review_items where summary like ${`${prefix}%`}`
		}
	})
})
