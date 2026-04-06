import { invalid } from '@sveltejs/kit'
import { form, getRequestEvent } from '$app/server'
import { z } from 'zod'
import { isValidPassword, setSessionCookie } from '$lib/auth/auth.server'

const loginSchema = z.object({
	password: z.string().min(1),
})

export const loginAction = form(loginSchema, async ({ password }) => {
	const event = getRequestEvent()

	if (!password || !isValidPassword(password)) {
		invalid('Invalid password')
	}

	setSessionCookie(event.cookies)
	return { success: true }
})

