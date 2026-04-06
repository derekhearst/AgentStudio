import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { env } from '$env/dynamic/private'
import { db } from '$lib/db.server'
import { authChallenges, userPasskeys, users } from '$lib/auth/auth.schema'
import {
	consumeBootstrapClaim,
	createSessionForUser,
	touchUserLastLogin,
	validateBootstrapClaim,
} from '$lib/auth/auth.server'
import type { Cookies } from '@sveltejs/kit'

const CHALLENGE_TTL_MS = 1000 * 60 * 10

function userIdToBytes(userId: string) {
	return new TextEncoder().encode(userId)
}

function toBase64Url(bytes: Uint8Array) {
	return Buffer.from(bytes).toString('base64url')
}

function fromBase64Url(encoded: string) {
	return new Uint8Array(Buffer.from(encoded, 'base64url'))
}

async function getActiveUser(userId: string) {
	const [user] = await db
		.select()
		.from(users)
		.where(and(eq(users.id, userId), eq(users.isActive, true), isNull(users.deletedAt)))
		.limit(1)
	return user ?? null
}

async function requiresBootstrapClaim(userId: string) {
	const bootstrapUsername = env.USER_NAME
	if (!bootstrapUsername) return false

	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
	if (!user) return false
	if (user.username !== bootstrapUsername || user.claimedAt) return false

	const [claimedUser] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.isActive, true), isNull(users.deletedAt), gt(users.claimedAt, new Date(0))))
		.limit(1)

	return !claimedUser
}

export async function listLoginUsers() {
	return db
		.select({
			id: users.id,
			username: users.username,
			name: users.name,
			claimed: users.claimedAt,
		})
		.from(users)
		.where(and(eq(users.isActive, true), isNull(users.deletedAt)))
		.orderBy(asc(users.username))
}

export async function beginPasskeyRegistration(input: {
	userId: string
	rpID: string
	origin: string
	claimKey?: string
}) {
	const user = await getActiveUser(input.userId)
	if (!user) {
		throw new Error('User not found')
	}
	if (user.claimedAt) {
		throw new Error('This account is already claimed')
	}

	if (await requiresBootstrapClaim(user.id)) {
		if (!input.claimKey) {
			throw new Error('A bootstrap claim key is required for the first admin login')
		}
		const isValidClaim = await validateBootstrapClaim(input.claimKey)
		if (!isValidClaim) {
			throw new Error('Invalid or expired bootstrap claim key')
		}
	}

	const existingPasskeys = await db
		.select({ credentialId: userPasskeys.credentialId })
		.from(userPasskeys)
		.where(eq(userPasskeys.userId, user.id))

	const options = await generateRegistrationOptions({
		rpName: 'AGENTSTUDIO',
		rpID: input.rpID,
		userName: user.username,
		userID: userIdToBytes(user.id),
		attestationType: 'none',
		excludeCredentials: existingPasskeys.map((passkey) => ({ id: passkey.credentialId })),
		authenticatorSelection: {
			userVerification: 'required',
			residentKey: 'preferred',
		},
	})

	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
	const [challenge] = await db
		.insert(authChallenges)
		.values({
			userId: user.id,
			purpose: 'register',
			challenge: options.challenge,
			expiresAt,
		})
		.returning({ id: authChallenges.id })

	return {
		challengeId: challenge.id,
		options,
	}
}

export async function finishPasskeyRegistration(input: {
	challengeId: string
	response: RegistrationResponseJSON
	rpID: string
	origin: string
	claimKey?: string
	cookies: Cookies
}) {
	const now = new Date()
	const [challenge] = await db
		.select()
		.from(authChallenges)
		.where(
			and(
				eq(authChallenges.id, input.challengeId),
				eq(authChallenges.purpose, 'register'),
				gt(authChallenges.expiresAt, now),
			),
		)
		.limit(1)

	if (!challenge || !challenge.userId) {
		throw new Error('Invalid or expired registration challenge')
	}

	const user = await getActiveUser(challenge.userId)
	if (!user) {
		throw new Error('User not found')
	}

	const verification = await verifyRegistrationResponse({
		response: input.response,
		expectedChallenge: challenge.challenge,
		expectedOrigin: input.origin,
		expectedRPID: input.rpID,
		requireUserVerification: true,
	})

	if (!verification.verified || !verification.registrationInfo) {
		throw new Error('Passkey registration verification failed')
	}

	if (await requiresBootstrapClaim(user.id)) {
		if (!input.claimKey) {
			throw new Error('A bootstrap claim key is required for the first admin login')
		}
		const consumed = await consumeBootstrapClaim(input.claimKey)
		if (!consumed) {
			throw new Error('Invalid or expired bootstrap claim key')
		}
	}

	const { credential } = verification.registrationInfo
	await db.insert(userPasskeys).values({
		userId: user.id,
		credentialId: credential.id,
		publicKey: toBase64Url(credential.publicKey),
		counter: credential.counter,
		transports: credential.transports ?? [],
		lastUsedAt: now,
	})

	await db
		.update(users)
		.set({
			claimedAt: user.claimedAt ?? now,
			lastLoginAt: now,
		})
		.where(eq(users.id, user.id))

	await db.delete(authChallenges).where(eq(authChallenges.id, challenge.id))
	await createSessionForUser(input.cookies, user.id)
	return { success: true as const }
}

export async function beginPasskeyLogin(input: { userId: string; rpID: string }) {
	const user = await getActiveUser(input.userId)
	if (!user || !user.claimedAt) {
		throw new Error('This account is unavailable for sign in')
	}

	const passkeys = await db
		.select({
			credentialId: userPasskeys.credentialId,
			transports: userPasskeys.transports,
		})
		.from(userPasskeys)
		.where(eq(userPasskeys.userId, user.id))

	if (passkeys.length === 0) {
		throw new Error('This account has no passkeys registered')
	}

	const options = await generateAuthenticationOptions({
		rpID: input.rpID,
		allowCredentials: passkeys.map((passkey) => ({
			id: passkey.credentialId,
			transports: passkey.transports as Array<'ble' | 'hybrid' | 'internal' | 'nfc' | 'usb'>,
		})),
		userVerification: 'required',
	})

	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
	const [challenge] = await db
		.insert(authChallenges)
		.values({
			userId: user.id,
			purpose: 'authenticate',
			challenge: options.challenge,
			expiresAt,
		})
		.returning({ id: authChallenges.id })

	return {
		challengeId: challenge.id,
		options,
	}
}

export async function finishPasskeyLogin(input: {
	challengeId: string
	response: AuthenticationResponseJSON
	rpID: string
	origin: string
	cookies: Cookies
}) {
	const now = new Date()
	const [challenge] = await db
		.select()
		.from(authChallenges)
		.where(
			and(
				eq(authChallenges.id, input.challengeId),
				eq(authChallenges.purpose, 'authenticate'),
				gt(authChallenges.expiresAt, now),
			),
		)
		.limit(1)

	if (!challenge || !challenge.userId) {
		throw new Error('Invalid or expired sign-in challenge')
	}

	const [passkey] = await db
		.select()
		.from(userPasskeys)
		.where(and(eq(userPasskeys.userId, challenge.userId), eq(userPasskeys.credentialId, input.response.id)))
		.limit(1)

	if (!passkey) {
		throw new Error('Passkey not recognized for this account')
	}

	const verification = await verifyAuthenticationResponse({
		response: input.response,
		expectedChallenge: challenge.challenge,
		expectedOrigin: input.origin,
		expectedRPID: input.rpID,
		credential: {
			id: passkey.credentialId,
			publicKey: fromBase64Url(passkey.publicKey),
			counter: passkey.counter,
			transports: passkey.transports as Array<'ble' | 'hybrid' | 'internal' | 'nfc' | 'usb'>,
		},
		requireUserVerification: true,
	})

	if (!verification.verified) {
		throw new Error('Passkey authentication failed')
	}

	await db
		.update(userPasskeys)
		.set({
			counter: verification.authenticationInfo.newCounter,
			lastUsedAt: now,
		})
		.where(eq(userPasskeys.id, passkey.id))

	await touchUserLastLogin(challenge.userId)
	await db.delete(authChallenges).where(eq(authChallenges.id, challenge.id))
	await createSessionForUser(input.cookies, challenge.userId)

	return { success: true as const }
}
