import { command, getRequestEvent, query } from '$app/server'
import { clearSessionCookie, isAuthenticated } from '$lib/auth/auth.server'

export const getSession = query(async () => {
	const event = getRequestEvent()
	return {
		authenticated: isAuthenticated(event.cookies),
	}
})

export const logout = command(async () => {
	const event = getRequestEvent()
	clearSessionCookie(event.cookies)
	return { success: true }
})

