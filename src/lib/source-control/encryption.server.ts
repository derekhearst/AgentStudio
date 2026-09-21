import { decryptWithKey, deriveKeyFromSecret, encryptWithKey } from './encryption'

/**
 * Wave 5 #19 phase 2 — server-side wrappers around the pure encryption helpers.
 *
 * Reads the secret from APP_ENCRYPTION_KEY. There used to be a CLAIM_KEY fallback for
 * environments that never set an explicit secret; it was dropped once the TrueNAS app was
 * moved onto APP_ENCRYPTION_KEY (same value, so stored tokens still decrypt). A second
 * accepted name is a footgun here: set the wrong one and every stored token silently fails
 * to decrypt. The pure helpers in `./encryption` stay env-free so unit tests can use them
 * with a fixed key.
 */

function getKey(): Buffer {
	const secret = process.env.APP_ENCRYPTION_KEY
	if (!secret || secret.length === 0) {
		throw new Error('Token encryption requires APP_ENCRYPTION_KEY to be set in the environment.')
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
	const secret = process.env.APP_ENCRYPTION_KEY
	return !!secret && secret.length > 0
}
