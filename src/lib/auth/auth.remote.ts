import { command, getRequestEvent, query } from '$app/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { users } from '$lib/auth/auth.schema'
import {
	clearSessionCookie,
	createSessionForUser,
	findUserForLogin,
	getProvisionedUser,
	isProvisioned,
	touchUserLastLogin,
	validateUsername,
} from '$lib/auth/auth.server'
import { hashPassword, verifyPassword } from '$lib/auth/password.server'

export const getSession = query(async () => {
	const event = getRequestEvent()
	const user = event.locals.user ?? null
	return {
		authenticated: Boolean(user),
		user,
	}
})

export const isProvisionedQuery = query(async () => {
	return { provisioned: await isProvisioned() }
})

const loginSchema = z.object({
	password: z.string().min(1).max(512),
})

export const loginCommand = command(loginSchema, async ({ password }) => {
	const event = getRequestEvent()
	const user = await findUserForLogin()
	if (!user || !user.passwordHash) {
		throw new Error('Invalid password')
	}

	const ok = await verifyPassword(password, user.passwordHash)
	if (!ok) {
		throw new Error('Invalid password')
	}

	await createSessionForUser(event.cookies, user.id)
	await touchUserLastLogin(user.id)
	return { success: true as const }
})

const setupSchema = z.object({
	name: z.string().trim().min(1).max(64),
	username: z.string().trim().min(3).max(32),
	password: z.string().min(8).max(512),
})

export const setupCommand = command(setupSchema, async (input) => {
	const event = getRequestEvent()

	if (await isProvisioned()) {
		throw new Error('Setup already completed')
	}

	const username = validateUsername(input.username)
	const passwordHash = await hashPassword(input.password)
	const existing = await getProvisionedUser()

	let userId: string
	if (existing) {
		await db
			.update(users)
			.set({ name: input.name, username, passwordHash })
			.where(eq(users.id, existing.id))
		userId = existing.id
	} else {
		const [created] = await db
			.insert(users)
			.values({ name: input.name, username, passwordHash })
			.returning({ id: users.id })
		userId = created.id
	}

	await createSessionForUser(event.cookies, userId)
	await touchUserLastLogin(userId)
	return { success: true as const }
})

export const logout = command(async () => {
	const event = getRequestEvent()
	await clearSessionCookie(event.cookies)
	return { success: true }
})
