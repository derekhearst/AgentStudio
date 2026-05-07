import { query } from '$app/server'
import { z } from 'zod'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { getImageForUser } from './images.server'

export const getImageQuery = query(z.string().uuid(), async (imageId) => {
	const user = requireAuthenticatedRequestUser()
	const row = await getImageForUser(user.id, imageId)
	if (!row) return null
	return row
})
