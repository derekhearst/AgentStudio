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

export { normalizeUsername, validateUsername } from '$lib/auth/username'

/**
 * Once an owner exists it keeps existing, so the answer is cached after the first `true` —
 * the gate asks on every page request. It is deliberately not cached while `false`: first
 * run must end the moment setup (or the boot step) creates the owner.
 *
 * The one way the cache can go stale is the owner disappearing under a running server
 * (`bun run db:reset` beside `bun run dev`, or an operator clearing the password to reopen
 * setup). A sign-in that finds no owner calls `forgetOwnerExists()`, so the next page
 * load goes to `/setup` instead of `/login` forever; a restart does the same.
 */
let ownerKnownToExist = false

/** Whether the instance has its owner: a `users` row with a password. */
export async function ownerExists(): Promise<boolean> {
	if (ownerKnownToExist) return true
	const [row] = await db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1)
	ownerKnownToExist = Boolean(row)
	return ownerKnownToExist
}

export function forgetOwnerExists() {
	ownerKnownToExist = false
}

/**
 * The owner's identity, for `AUTH_DEV_BYPASS` to attach a request to — or null when there is
 * no owner with a password.
 *
 * Only a provisioned owner. The bypass used to take whatever row it found, so on a
 * half-set-up instance (a row whose password was never set) it signed requests in as an
 * account that cannot sign in itself, while the setup gate treated the same instance as
 * having no owner. Now the bypass does nothing until there is a real owner to be.
 */
export async function findOwnerIdentity(): Promise<AuthenticatedUser | null> {
	const [row] = await db
		.select({ id: users.id, name: users.name, username: users.username })
		.from(users)
		.where(isNotNull(users.passwordHash))
		.limit(1)
	return row ?? null
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

/**
 * The signed-in user for this request's cookie, or null.
 *
 * A session only counts while its account has a password. Clearing `password_hash` is how an
 * operator reopens setup to recover a lost or leaked password; without this, a session opened
 * with the old password stayed signed in for the whole recovery window — while the gate
 * already treated the instance as having no owner — and could call every remote function.
 * Setting the new password then deletes those sessions for good (provision.server.ts).
 */
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
		.where(and(eq(authSessions.tokenHash, tokenHash), gt(authSessions.expiresAt, now), isNotNull(users.passwordHash)))
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
