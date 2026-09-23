import { command, getRequestEvent, query } from '$app/server'
import { dev } from '$app/environment'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { db } from '$lib/db.server'
import {
	clearSessionCookie,
	createSessionForUser,
	findUserForLogin,
	forgetOwnerExists,
	ownerExists,
	touchUserLastLogin,
} from '$lib/auth/auth.server'
import { verifyPassword } from '$lib/auth/password.server'
import { provisionOwner } from '$lib/auth/provision.server'
import { retireSetupToken, setupTokenMatches, setupTokenRequired } from '$lib/auth/setup-token.server'
import { MIN_PASSWORD_LENGTH } from '$lib/auth/username'

export const getSession = query(async () => {
	const event = getRequestEvent()
	const user = event.locals.user ?? null
	return {
		authenticated: Boolean(user),
		user,
	}
})

// Refusals are thrown with `error(status, message)`, not `new Error(message)`. SvelteKit hides
// the message of a plain Error from the client ("Internal Error") and logs it as a server
// fault, so a wrong password or setup token read as a crash on the page and in the log.

const loginSchema = z.object({
	password: z.string().min(1).max(512),
})

export const loginCommand = command(loginSchema, async ({ password }) => {
	const event = getRequestEvent()
	const user = await findUserForLogin()
	if (!user || !user.passwordHash) {
		// The owner is gone from under a running server (a `db:reset` beside `bun run dev`, or
		// a password cleared to reopen setup): stop the gate sending everyone to /login.
		forgetOwnerExists()
		error(409, 'This instance has no owner yet. Reload the page to set it up.')
	}

	const ok = await verifyPassword(password, user.passwordHash)
	if (!ok) {
		error(401, 'Invalid password')
	}

	await createSessionForUser(event.cookies, user.id)
	await touchUserLastLogin(user.id)
	return { success: true as const }
})

// First run asks for the account only — a display name and a password. The username is
// optional (nobody types it to sign in) and defaults to `owner`. Everything else an instance
// needs (model credential, sandbox, gateway, integrations) is deploy-time configuration,
// shown read-only under Settings > System.
const setupSchema = z.object({
	name: z.string().trim().min(1).max(64),
	username: z
		.string()
		.trim()
		.regex(/^[a-zA-Z0-9_-]{3,32}$/)
		.optional(),
	password: z.string().min(MIN_PASSWORD_LENGTH).max(512),
	setupToken: z.string().trim().max(256).optional(),
})

export const setupCommand = command(setupSchema, async (input) => {
	const event = getRequestEvent()

	if (await ownerExists()) {
		error(409, 'Setup already completed')
	}

	// On a production server `/setup` belongs to whoever holds the token from the server
	// log, not to whoever loads the page first. See setup-token.server.ts.
	if (setupTokenRequired({ devBuild: dev }) && !setupTokenMatches(input.setupToken)) {
		error(403, 'That setup token is not right. Copy it from the server log.')
	}

	// Race-safe: of two submissions at the same moment, exactly one creates the owner.
	const result = await provisionOwner(db, input, { overwrite: false })
	if (!result.created) {
		error(409, 'Setup already completed')
	}
	retireSetupToken()

	await createSessionForUser(event.cookies, result.userId)
	await touchUserLastLogin(result.userId)
	return { success: true as const }
})

export const logout = command(async () => {
	const event = getRequestEvent()
	await clearSessionCookie(event.cookies)
	return { success: true }
})
