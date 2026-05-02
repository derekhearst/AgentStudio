import { query } from '$app/server'
import { listModels } from '$lib/llm/models.server'

export const getAvailableModels = query(async () => {
	return listModels()
})

