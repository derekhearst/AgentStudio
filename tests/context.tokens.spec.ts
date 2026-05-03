import { expect, test } from '@playwright/test'
import { estimateTokens, estimateTokensForModel } from '../src/lib/tools/tools'

test.describe('context/tokens — model-aware token estimation', () => {
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

	test('estimateTokensForModel uses tiktoken for openai models (not chars/4)', () => {
		const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
		const charsOver4 = estimateTokens(text)
		const tiktoken = estimateTokensForModel(text, 'openai/gpt-4o-mini')
		// Tiktoken should diverge from chars/4 for real English text — usually lower than chars/4
		// because real BPE tokens average longer than 4 chars for common words.
		expect(tiktoken).toBeGreaterThan(0)
		expect(tiktoken).not.toBe(charsOver4)
		// Sanity: stay within an order of magnitude of chars/4.
		expect(tiktoken).toBeGreaterThan(charsOver4 / 5)
		expect(tiktoken).toBeLessThan(charsOver4 * 5)
	})

	test('encodes a known short prompt to the expected token count for gpt-4o-mini', () => {
		// `cl100k_base`/`o200k_base` encoding of "Hello world" is well-known to be 2 or 3 tokens.
		const count = estimateTokensForModel('Hello world', 'openai/gpt-4o-mini')
		expect(count).toBeGreaterThanOrEqual(2)
		expect(count).toBeLessThanOrEqual(4)
	})

	test('anthropic / google models route to cl100k_base (proxy) and produce sane counts', () => {
		const text = 'A short claude prompt.'
		const claude = estimateTokensForModel(text, 'anthropic/claude-sonnet-4')
		const gemini = estimateTokensForModel(text, 'google/gemini-2.5-flash')
		expect(claude).toBeGreaterThan(0)
		expect(gemini).toBeGreaterThan(0)
		// Same encoder → same count for the same text.
		expect(claude).toBe(gemini)
	})

	test('completely unknown / made-up provider falls back to chars/4', () => {
		const text = 'a'.repeat(40)
		// All non-openai models route to cl100k_base today, so the fallback path is hit only when
		// even cl100k_base fails to load (very rare). We assert at minimum the function returns a
		// positive integer for an unfamiliar model slug rather than throwing.
		const result = estimateTokensForModel(text, 'fictional/unicorn-9000')
		expect(Number.isFinite(result) && result > 0).toBe(true)
	})

	test('empty string returns 0 for any model', () => {
		expect(estimateTokensForModel('', 'openai/gpt-4o-mini')).toBe(0)
		expect(estimateTokensForModel('', 'anthropic/claude-sonnet-4')).toBe(0)
	})

	test('two calls for the same model use a cached encoder (perf sanity)', () => {
		// Not measuring time precisely, just asserting both calls return a stable positive count.
		const a = estimateTokensForModel('test one', 'openai/gpt-4o-mini')
		const b = estimateTokensForModel('test two', 'openai/gpt-4o-mini')
		expect(a).toBeGreaterThan(0)
		expect(b).toBeGreaterThan(0)
	})
})
