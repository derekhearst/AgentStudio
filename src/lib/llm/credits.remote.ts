import { command, query } from '$app/server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { getCreditsBalance } from '$lib/llm/credits.server'

export const getCredits = query(async () => {
	requireAuthenticatedRequestUser()
	return getCreditsBalance()
})

export const refreshCredits = command(async () => {
	requireAuthenticatedRequestUser()
	return getCreditsBalance(true)
})
