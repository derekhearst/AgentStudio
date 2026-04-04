import { query } from '$app/server'
import { listModels } from '$lib/server/llm/models'

export const getAvailableModels = query(async () => {
	return listModels()
})
