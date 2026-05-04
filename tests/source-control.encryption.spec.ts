import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 2 — pure encryption helper invariants.
 *
 * Tests pull the env-free helpers from `./encryption` (the .server.ts wrapper just supplies
 * the key from $env). A fixed secret is used here so tests are deterministic and don't
 * depend on .env being set.
 */

const TEST_SECRET = 'unit-test-secret-not-for-production'

test.describe('source-control/encryption — AES-256-GCM round-trip', () => {
	test('encrypt → decrypt round-trips arbitrary strings', async () => {
		const { deriveKeyFromSecret, encryptWithKey, decryptWithKey } = await import('../src/lib/source-control/encryption')
		const key = deriveKeyFromSecret(TEST_SECRET)
		const inputs = [
			'simple',
			'github_pat_11ABC1234XYZ_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
			'unicode: 日本語 ✨',
			'',
			'a'.repeat(10_000),
		]
		for (const plaintext of inputs) {
			const enc = encryptWithKey(key, plaintext)
			expect(enc.startsWith('v1:')).toBe(true)
			expect(enc.split(':').length).toBe(4)
			const dec = decryptWithKey(key, enc)
			expect(dec).toBe(plaintext)
		}
	})

	test('two encryptions of the same plaintext produce different IV-tagged outputs', async () => {
		const { deriveKeyFromSecret, encryptWithKey, decryptWithKey } = await import('../src/lib/source-control/encryption')
		const key = deriveKeyFromSecret(TEST_SECRET)
		const plaintext = 'same input'
		const a = encryptWithKey(key, plaintext)
		const b = encryptWithKey(key, plaintext)
		expect(a).not.toBe(b)
		expect(decryptWithKey(key, a)).toBe(plaintext)
		expect(decryptWithKey(key, b)).toBe(plaintext)
	})

	test('tampered ciphertext is rejected by the auth tag', async () => {
		const { deriveKeyFromSecret, encryptWithKey, decryptWithKey } = await import('../src/lib/source-control/encryption')
		const key = deriveKeyFromSecret(TEST_SECRET)
		const enc = encryptWithKey(key, 'original')
		const parts = enc.split(':')
		const dataBytes = Buffer.from(parts[2], 'base64')
		dataBytes[0] = dataBytes[0] ^ 0xff
		parts[2] = dataBytes.toString('base64')
		const tampered = parts.join(':')
		expect(() => decryptWithKey(key, tampered)).toThrow()
	})

	test('decrypt rejects unsupported version prefix', async () => {
		const { deriveKeyFromSecret, decryptWithKey } = await import('../src/lib/source-control/encryption')
		const key = deriveKeyFromSecret(TEST_SECRET)
		expect(() => decryptWithKey(key, 'v0:nope:nope:nope')).toThrow(/Unsupported encrypted payload format/)
	})

	test('a different key cannot decrypt another key\'s ciphertext', async () => {
		const { deriveKeyFromSecret, encryptWithKey, decryptWithKey } = await import('../src/lib/source-control/encryption')
		const keyA = deriveKeyFromSecret('secret-a')
		const keyB = deriveKeyFromSecret('secret-b')
		const enc = encryptWithKey(keyA, 'some-token')
		expect(() => decryptWithKey(keyB, enc)).toThrow()
	})
})
