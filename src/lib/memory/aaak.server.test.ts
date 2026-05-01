/**
 * Unit tests for the AAAK encoder/decoder. Pure functions — no DB required.
 *
 *   bun test src/lib/memory/aaak.server.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { encodeAaak, decodeAaak, formatAddress, slugifyToken, aaakKeywords } from './aaak.server'

describe('aaak encode/decode', () => {
	test('roundtrips a populated tag bundle', () => {
		const encoded = encodeAaak(
			{ wing: 42, room: 11, drawer: 7 },
			{ p: ['Alice', 'Bob'], l: ['Tokyo'], e: ['Conf-25'], i: ['lemon-ginger tea'], t: ['2024-08-15'] },
		)
		expect(encoded.pointer.startsWith('§ W-042/R-11/D-007')).toBe(true)
		expect(encoded.tags.p).toEqual(['alice', 'bob'])
		expect(encoded.tags.l).toEqual(['tokyo'])
		expect(encoded.tags.e).toEqual(['conf-25'])
		expect(encoded.tags.t).toEqual(['2024-08-15'])

		const decoded = decodeAaak(encoded.pointer)
		expect(decoded.address).toEqual({ wing: 42, room: 11, drawer: 7 })
		expect(decoded.tags.p).toEqual(['alice', 'bob'])
		expect(decoded.tags.t).toEqual(['2024-08-15'])
	})

	test('formats address with zero-padded ordinals', () => {
		expect(formatAddress({ wing: 1, room: 1, drawer: 1 })).toBe('§ W-001/R-01/D-001')
		expect(formatAddress({ wing: 999, room: 99, drawer: 999 })).toBe('§ W-999/R-99/D-999')
	})

	test('handles empty tags gracefully', () => {
		const encoded = encodeAaak({ wing: 1, room: 1, drawer: 1 }, {})
		expect(encoded.pointer).toBe('§ W-001/R-01/D-001')
		expect(aaakKeywords(encoded)).toBe('')
	})

	test('slugifyToken normalizes punctuation and case', () => {
		expect(slugifyToken('  Hello World!  ')).toBe('hello-world')
		expect(slugifyToken("O'Reilly's BBQ")).toBe('oreillys-bbq')
		expect(slugifyToken('---multi---dash---')).toBe('multi-dash')
	})

	test('aaakKeywords joins all tag values', () => {
		const encoded = encodeAaak(
			{ wing: 1, room: 1, drawer: 1 },
			{ p: ['Alice', 'Alice', 'Bob'], i: ['tea'] },
		)
		const kws = aaakKeywords(encoded)
		expect(kws).toContain('alice')
		expect(kws).toContain('bob')
		expect(kws).toContain('tea')
	})

	test('decodeAaak throws on malformed input', () => {
		expect(() => decodeAaak('not an address')).toThrow()
		expect(() => decodeAaak('')).toThrow()
	})
})
