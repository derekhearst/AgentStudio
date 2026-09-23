import { expect, test } from '@playwright/test'
import { estimateTokens } from '../src/lib/tools/tools'

/**
 * The chars/4 estimate the context slots budget with. There used to be a model-aware
 * tiktoken estimator next to it; its only caller was the old loop's in-house compaction,
 * deleted in #8, so it went with it.
 */
test.describe('context/tokens — chars/4 token estimation', () => {
	test('chars/4 fallback handles empty + null inputs gracefully', () => {
		expect(estimateTokens('')).toBe(0)
		// @ts-expect-error: deliberately exercise the null/undefined guard
		expect(estimateTokens(null)).toBe(0)
		// @ts-expect-error: deliberately exercise the null/undefined guard
		expect(estimateTokens(undefined)).toBe(0)
	})

	test('chars/4 fallback yields ceil(len/4)', () => {
		expect(estimateTokens('a')).toBe(1)
		expect(estimateTokens('abcd')).toBe(1)
		expect(estimateTokens('abcde')).toBe(2)
		expect(estimateTokens('a'.repeat(4001))).toBe(1001)
	})
})
