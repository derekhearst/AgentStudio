import { createHash, randomBytes } from 'node:crypto'
import { error } from '@sveltejs/kit'
import type { Cookies } from '@sveltejs/kit'

// Lazy-load `getRequestEvent` from `$app/server` so this module is importable from
// non-SvelteKit contexts (Playwright Node runtime, scripts). Tests never call
// `requireAuthenticatedRequestUser` (they use raw SQL via getSql); the dev/prod path
// resolves the SvelteKit virtual module on first use.
let _getRequestEvent: (() => { locals: { user?: AuthenticatedUser } }) | null = null
try {
	const mod = (await import('$app/server')) as unknown as { getRequestEvent: () => { locals: { user?: AuthenticatedUser } } }
	_getRequestEvent = mod.getRequestEvent
} catch {
	// $app/server not resolvable — auth-context-required functions throw at call time below.
}
import { and, eq, gt, isNotNull } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { authSessions, users } from '$lib/auth/auth.schema'

const SESSION_COOKIE = 'AgentStudio_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export type AuthenticatedUser = {
	id: string
	name: string
	username: string
}

function hashToken(token: string) {
	return createHash('sha256').update(token).digest('base64url')
}

function shouldUseSecureCookie() {
	return process.env.NODE_ENV === 'production'
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

export async function getProvisionedUser() {
	const [row] = await db
		.select({ id: users.id, passwordHash: users.passwordHash })
		.from(users)
		.limit(1)
	return row ?? null
}

export async function isProvisioned() {
	const row = await getProvisionedUser()
	return row !== null && row.passwordHash !== null
}

export async function findUserForLogin() {
	const [row] = await db
		.select({ id: users.id, name: users.name, username: users.username, passwordHash: users.passwordHash })
		.from(users)
		.where(isNotNull(users.passwordHash))
		.limit(1)
	return row ?? null
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
		})
		.from(authSessions)
		.innerJoin(users, eq(users.id, authSessions.userId))
		.where(and(eq(authSessions.tokenHash, tokenHash), gt(authSessions.expiresAt, now)))
		.limit(1)

	if (!row) return null

	return {
		id: row.id,
		name: row.name,
		username: row.username,
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
	if (!_getRequestEvent) {
		throw error(500, 'Auth context unavailable (SvelteKit virtual module not loaded)')
	}
	const event = _getRequestEvent()
	if (!event.locals.user) {
		throw error(401, 'Not authenticated')
	}
	return event.locals.user
}
