import { query } from '$app/server'
import { listModels } from '$lib/models/models'

export const getAvailableModels = query(async () => {
	return listModels()
})

