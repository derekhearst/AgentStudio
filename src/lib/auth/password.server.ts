import { hash, verify } from '@node-rs/argon2'

// Argon2id is the @node-rs/argon2 default — explicit enum import would pull in a const
// enum that conflicts with verbatimModuleSyntax. Memory/time/parallelism tuned for an
// interactive single-user instance.
const ARGON_OPTIONS = {
	memoryCost: 65536,
	timeCost: 3,
	parallelism: 1,
} as const

export function hashPassword(plaintext: string): Promise<string> {
	return hash(plaintext, ARGON_OPTIONS)
}

export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
	try {
		return await verify(storedHash, plaintext)
	} catch {
		return false
	}
}
