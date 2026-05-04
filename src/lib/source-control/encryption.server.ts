import { env } from '$env/dynamic/private'
import { decryptWithKey, deriveKeyFromSecret, encryptWithKey } from './encryption'

/**
 * Wave 5 #19 phase 2 — server-side wrappers around the pure encryption helpers.
 *
 * Reads the secret from APP_ENCRYPTION_KEY (preferred) with CLAIM_KEY fallback so dev
 * environments without an explicit secret still work. The pure helpers in `./encryption`
 * stay env-free so unit tests can use them with a fixed key.
 */

function getKey(): Buffer {
	const secret = env.APP_ENCRYPTION_KEY ?? env.CLAIM_KEY
	if (!secret || secret.length === 0) {
		throw new Error(
			'Token encryption requires APP_ENCRYPTION_KEY or CLAIM_KEY to be set in the environment.',
		)
	}
	return deriveKeyFromSecret(secret)
}

export function encryptSecret(plaintext: string): string {
	return encryptWithKey(getKey(), plaintext)
}

export function decryptSecret(payload: string): string {
	return decryptWithKey(getKey(), payload)
}

export function hasEncryptionKey(): boolean {
	const secret = env.APP_ENCRYPTION_KEY ?? env.CLAIM_KEY
	return !!secret && secret.length > 0
}
