import { command, getRequestEvent, query } from '$app/server'
import { z } from 'zod'
import { clearSessionCookie } from '$lib/auth/auth.server'
import {
	beginPasskeyLogin,
	beginPasskeyRegistration,
	finishPasskeyLogin,
	finishPasskeyRegistration,
	listLoginUsers,
} from '$lib/auth/passkey.server'

const startChallengeSchema = z.object({
	userId: z.string().uuid(),
	claimKey: z.string().trim().min(1).optional(),
})

const finishRegistrationSchema = z.object({
	challengeId: z.string().uuid(),
	response: z.unknown(),
	claimKey: z.string().trim().min(1).optional(),
})

const finishLoginSchema = z.object({
	challengeId: z.string().uuid(),
	response: z.unknown(),
})

export const getSession = query(async () => {
	const event = getRequestEvent()
	const user = event.locals.user ?? null
	return {
		authenticated: Boolean(user),
		user,
	}
})

export const listLoginUsersQuery = query(async () => {
	const users = await listLoginUsers()
	return users.map((user) => ({
		id: user.id,
		username: user.username,
		name: user.name,
		claimed: Boolean(user.claimed),
	}))
})

export const startPasskeyRegistration = command(startChallengeSchema, async ({ userId, claimKey }) => {
	const event = getRequestEvent()
	return beginPasskeyRegistration({
		userId,
		rpID: event.url.hostname,
		origin: event.url.origin,
		claimKey,
	})
})

export const finishPasskeyRegistrationCommand = command(
	finishRegistrationSchema,
	async ({ challengeId, response, claimKey }) => {
		const event = getRequestEvent()
		return finishPasskeyRegistration({
			challengeId,
			response: response as unknown as import('@simplewebauthn/server').RegistrationResponseJSON,
			rpID: event.url.hostname,
			origin: event.url.origin,
			claimKey,
			cookies: event.cookies,
		})
	},
)

export const startPasskeyLogin = command(startChallengeSchema.pick({ userId: true }), async ({ userId }) => {
	const event = getRequestEvent()
	return beginPasskeyLogin({
		userId,
		rpID: event.url.hostname,
	})
})

export const finishPasskeyLoginCommand = command(finishLoginSchema, async ({ challengeId, response }) => {
	const event = getRequestEvent()
	return finishPasskeyLogin({
		challengeId,
		response: response as unknown as import('@simplewebauthn/server').AuthenticationResponseJSON,
		rpID: event.url.hostname,
		origin: event.url.origin,
		cookies: event.cookies,
	})
})

export const logout = command(async () => {
	const event = getRequestEvent()
	await clearSessionCookie(event.cookies)
	return { success: true }
})

