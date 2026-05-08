/**
 * Shared HTTP API-route helpers.
 *
 * Routes under `src/routes/api/**` use a few recurring patterns. This module
 * provides minimal wrappers so each handler doesn't have to repeat them:
 *
 *   - `requireAuth` — checks `locals.user`, throws a uniform 401, and forwards
 *     a typed `user` to the handler. Used by the user-scoped routes (transcribe,
 *     tts, video-jobs, future per-user API endpoints).
 *
 * Auth shapes that don't fit this pattern (cron-secret, MCP API key, GitHub
 * webhook HMAC) intentionally stay inline — they have different verification
 * mechanics, different failure semantics, and don't benefit from a wrapper.
 */

import { error, type RequestHandler } from '@sveltejs/kit'
import type { RequestEvent } from '@sveltejs/kit'

type User = NonNullable<App.Locals['user']>

type AuthedEvent<Params extends Partial<Record<string, string>> = Partial<Record<string, string>>> =
	RequestEvent<Params> & {
		user: User
	}

export function requireAuth<Params extends Partial<Record<string, string>> = Partial<Record<string, string>>>(
	handler: (event: AuthedEvent<Params>) => Response | Promise<Response>,
): RequestHandler<Params> {
	return async (event) => {
		if (!event.locals.user) {
			throw error(401, 'Unauthorized')
		}
		return handler({ ...event, user: event.locals.user })
	}
}
