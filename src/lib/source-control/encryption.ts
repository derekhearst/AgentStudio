import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Wave 5 #19 phase 2 — AES-256-GCM helpers, environment-free.
 *
 * The server-side wrapper module supplies the key (read from APP_ENCRYPTION_KEY / CLAIM_KEY).
 * Tests use the pure functions directly with a known key so they don't depend on $env.
 *
 * Format on disk: `v1:<base64iv>:<base64ciphertext>:<base64authtag>` — version prefix lets
 * us rotate the algorithm later without ambiguity.
 */

const ALG = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard
const VERSION = 'v1'

export function deriveKeyFromSecret(secret: string): Buffer {
	if (!secret || secret.length === 0) {
		throw new Error('deriveKeyFromSecret requires a non-empty secret')
	}
	return createHash('sha256').update(secret, 'utf8').digest()
}

export function encryptWithKey(key: Buffer, plaintext: string): string {
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALG, key, iv)
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	const tag = cipher.getAuthTag()
	return `${VERSION}:${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`
}

export function decryptWithKey(key: Buffer, payload: string): string {
	if (!payload.startsWith(`${VERSION}:`)) {
		throw new Error(`Unsupported encrypted payload format (expected ${VERSION}:…)`)
	}
	const parts = payload.split(':')
	if (parts.length !== 4) {
		throw new Error('Malformed encrypted payload')
	}
	const [, ivB64, dataB64, tagB64] = parts
	if (!ivB64 || !tagB64) {
		throw new Error('Malformed encrypted payload')
	}
	const iv = Buffer.from(ivB64, 'base64')
	const data = Buffer.from(dataB64, 'base64')
	const tag = Buffer.from(tagB64, 'base64')
	const decipher = createDecipheriv(ALG, key, iv)
	decipher.setAuthTag(tag)
	const dec = Buffer.concat([decipher.update(data), decipher.final()])
	return dec.toString('utf8')
}
