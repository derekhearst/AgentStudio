import { query } from '$app/server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'
import { listSpeechModels } from '$lib/llm/tts.server'
import { logger } from '$lib/observability/logger'

/**
 * OpenRouter's speech models, for the read-aloud pickers in Settings > Model & AI.
 *
 * Degrades to an empty list like `getAvailableModels`: the pickers fall back to plain text
 * fields, and the saved model and voice keep working, so an unreachable catalogue must not
 * take the settings page down with it.
 */
export const getSpeechModels = query(async () => {
	requireAuthenticatedRequestUser()
	try {
		return await listSpeechModels()
	} catch (error) {
		logger.warn('[speech] speech model catalogue unavailable; serving an empty picker', {
			error: error instanceof Error ? error.message : String(error),
		})
		return []
	}
})
