import { createHash, randomBytes } from 'node:crypto'
import { env } from '$env/dynamic/private'
import { getRequestEvent } from '$app/server'
import type { Cookies } from '@sveltejs/kit'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { authSessions, bootstrapClaims, users, userRoleEnum } from '$lib/auth/auth.schema'

const SESSION_COOKIE = 'AGENTSTUDIO_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const BOOTSTRAP_CLAIM_TTL_MS = 1000 * 60 * 30

type UserRole = (typeof userRoleEnum.enumValues)[number]

export type AuthenticatedUser = {
	id: string
	name: string
	username: string
	role: UserRole
}

let bootstrapPromise: Promise<void> | null = null

function hashToken(token: string) {
	return createHash('sha256').update(token).digest('base64url')
}

function shouldUseSecureCookie() {
	return env.NODE_ENV === 'production'
}

export function normalizeUsername(input: string) {
	return input.trim()
}

export function validateUsername(input: string) {
	const normalized = normalizeUsername(input)
	if (!/^[a-zA-Z0-9_-]{3,32}$/.test(normalized)) {
		throw new Error('Username must contain only letters, numbers, underscore, or hyphen')
	}
	return normalized
}

async function ensureBootstrapClaimExists(baseUrl?: string) {
	const adminUsername = env.USER_NAME
	const claimKey = env.CLAIM_KEY
	if (!adminUsername || !claimKey) {
		console.warn('[auth] USER_NAME and CLAIM_KEY env vars are required for bootstrap. Skipping.')
		return
	}

	const [admin] = await db.select().from(users).where(eq(users.username, adminUsername)).limit(1)

	const adminUser =
		admin ??
		(
			await db
				.insert(users)
				.values({
					name: adminUsername,
					username: adminUsername,
					role: 'admin',
					isActive: true,
				})
				.returning()
		)[0]

	if (adminUser.claimedAt) return

	const now = new Date()
	const [activeClaim] = await db
		.select({ id: bootstrapClaims.id })
		.from(bootstrapClaims)
		.where(and(isNull(bootstrapClaims.usedAt), gt(bootstrapClaims.expiresAt, now)))
		.limit(1)

	if (activeClaim) return

	const tokenHash = hashToken(claimKey)
	const expiresAt = new Date(Date.now() + BOOTSTRAP_CLAIM_TTL_MS)

	await db.insert(bootstrapClaims).values({ tokenHash, expiresAt })

	const hintUrl = baseUrl ? `${baseUrl}/login?claim=${encodeURIComponent(claimKey)}` : '(login URL unavailable)'
	console.log('[auth] Initial admin bootstrap created.')
	console.log(`[auth] Visit: ${hintUrl}`)
}

export async function ensureAuthBootstrap(baseUrl?: string) {
	if (!bootstrapPromise) {
		bootstrapPromise = ensureBootstrapClaimExists(baseUrl).finally(() => {
			bootstrapPromise = null
		})
	}
	await bootstrapPromise
}

async function findActiveBootstrapClaim(claimKey: string) {
	const tokenHash = hashToken(claimKey)
	const now = new Date()

	const [claim] = await db
		.select()
		.from(bootstrapClaims)
		.where(
			and(eq(bootstrapClaims.tokenHash, tokenHash), isNull(bootstrapClaims.usedAt), gt(bootstrapClaims.expiresAt, now)),
		)
		.limit(1)

	return claim ?? null
}

export async function validateBootstrapClaim(claimKey: string) {
	const claim = await findActiveBootstrapClaim(claimKey)
	return claim !== null
}

export async function consumeBootstrapClaim(claimKey: string) {
	const claim = await findActiveBootstrapClaim(claimKey)
	if (!claim) return false

	const now = new Date()
	await db.update(bootstrapClaims).set({ usedAt: now }).where(eq(bootstrapClaims.id, claim.id))
	return true
}

export async function createSessionForUser(cookies: Cookies, userId: string) {
	const token = randomBytes(32).toString('base64url')
	const tokenHash = hashToken(token)
	const expiresAt = new Date(Date.now() + MAX_AGE_SECONDS * 1000)

	await db.insert(authSessions).values({ userId, tokenHash, expiresAt })

	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: shouldUseSecureCookie(),
		sameSite: 'lax',
		maxAge: MAX_AGE_SECONDS,
	})
}

export async function clearSessionCookie(cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE)
	if (token) {
		const tokenHash = hashToken(token)
		await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash))
	}

	cookies.delete(SESSION_COOKIE, {
		path: '/',
	})
}

export async function getSessionUser(cookies: Cookies): Promise<AuthenticatedUser | null> {
	const token = cookies.get(SESSION_COOKIE)
	if (!token) return null

	const tokenHash = hashToken(token)
	const now = new Date()

	const [row] = await db
		.select({
			id: users.id,
			name: users.name,
			username: users.username,
			role: users.role,
			sessionId: authSessions.id,
		})
		.from(authSessions)
		.innerJoin(users, eq(users.id, authSessions.userId))
		.where(
			and(
				eq(authSessions.tokenHash, tokenHash),
				gt(authSessions.expiresAt, now),
				eq(users.isActive, true),
				isNull(users.deletedAt),
			),
		)
		.limit(1)

	if (!row) return null

	return {
		id: row.id,
		name: row.name,
		username: row.username,
		role: row.role,
	}
}

export async function isAuthenticated(cookies: Cookies) {
	const user = await getSessionUser(cookies)
	return user !== null
}

export async function touchUserLastLogin(userId: string) {
	await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId))
}

export function requireAuthenticatedRequestUser() {
	const event = getRequestEvent()
	if (!event.locals.user) {
		throw new Error('Not authenticated')
	}
	return event.locals.user
}

export function requireAdminRequestUser() {
	const user = requireAuthenticatedRequestUser()
	if (user.role !== 'admin') {
		throw new Error('Admin access required')
	}
	return user
}
