import { command, query } from '$app/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '$lib/db.server'
import { users } from '$lib/auth/auth.schema'
import { normalizeUsername, requireAdminRequestUser } from '$lib/auth/auth.server'
import { auditUserCreated, auditUserDeactivated, auditUserRoleChanged } from '$lib/governance'

const createUserSchema = z.object({
	username: z
		.string()
		.trim()
		.min(3)
		.max(32)
		.regex(/^[a-zA-Z0-9_-]+$/, 'Username must contain only letters, numbers, underscore, or hyphen'),
	name: z.string().trim().min(1).max(64).optional(),
	role: z.enum(['admin', 'user']).default('user'),
})

const userIdSchema = z.string().uuid()

export const listUsersQuery = query(async () => {
	requireAdminRequestUser()
	const rows = await db.select().from(users).orderBy(asc(users.username))
	return rows.map((user) => ({
		...user,
		claimed: user.claimedAt !== null,
		deleted: user.deletedAt !== null,
	}))
})

export const createUserCommand = command(createUserSchema, async (input) => {
	const admin = requireAdminRequestUser()
	const username = normalizeUsername(input.username)
	const displayName = input.name?.trim() || username

	const [created] = await db
		.insert(users)
		.values({
			name: displayName,
			username,
			role: input.role,
			isActive: true,
		})
		.returning()

	if (created) {
		void auditUserCreated({
			actorUserId: admin.id,
			createdUserId: created.id,
			username,
			role: input.role,
		})
	}

	return created
})

export const softDeleteUserCommand = command(userIdSchema, async (userId) => {
	const admin = requireAdminRequestUser()
	if (admin.id === userId) {
		throw new Error('You cannot delete your own account')
	}

	const [target] = await db
		.select({ username: users.username })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)

	await db
		.update(users)
		.set({
			isActive: false,
			deletedAt: new Date(),
		})
		.where(eq(users.id, userId))

	void auditUserDeactivated({
		actorUserId: admin.id,
		targetUserId: userId,
		username: target?.username ?? null,
	})

	return { success: true as const }
})

export const restoreUserCommand = command(userIdSchema, async (userId) => {
	requireAdminRequestUser()

	await db
		.update(users)
		.set({
			isActive: true,
			deletedAt: null,
		})
		.where(eq(users.id, userId))

	return { success: true as const }
})

const setUserRoleSchema = z.object({
	userId: z.string().uuid(),
	role: z.enum(['admin', 'user']),
})

export const setUserRoleCommand = command(setUserRoleSchema, async ({ userId, role }) => {
	const admin = requireAdminRequestUser()
	if (admin.id === userId) {
		throw new Error('You cannot change your own role')
	}

	const [target] = await db
		.select({ username: users.username, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)
	if (!target) {
		throw new Error('User not found')
	}
	if (target.role === role) {
		return { success: true as const, changed: false }
	}

	await db.update(users).set({ role }).where(eq(users.id, userId))

	void auditUserRoleChanged({
		actorUserId: admin.id,
		targetUserId: userId,
		username: target.username,
		beforeRole: target.role,
		afterRole: role,
	})

	return { success: true as const, changed: true }
})
