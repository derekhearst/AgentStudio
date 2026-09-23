import { expect, test } from '@playwright/test'

/**
 * The inbox's type filter accepts every review item type the database has.
 *
 * The list was a hand-kept copy that missed `pull_request_checks_failed`: choosing "PR
 * checks failed" in /review failed validation, and the page went on showing the previous
 * filter's items under the new label. Both the server's schema and the page's labels now
 * come from the enum.
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
})
