import { error } from '@sveltejs/kit'

/**
 * A problem the person at the form can fix, with a message written for them — "monitor limit
 * reached, cancel one first", `Invalid cron hour field "25": …`.
 *
 * A remote function that lets a plain Error escape answers with SvelteKit's generic 500, whose
 * message `handleError` sets to "Internal Error": the page can only say "that did not work".
 * Server modules throw this instead, and remote functions run their bodies through
 * `withUserInputErrors`, which turns it into a 400 carrying the message. It is still an
 * Error, so callers that are not remote functions — the agent's tool handlers — read
 * `.message` exactly as before.
 */
export class UserInputError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'UserInputError'
	}
}

/** Run a remote function body, answering a `UserInputError` with a 400 the client can show. */
export async function withUserInputErrors<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (err) {
		if (err instanceof UserInputError) error(400, err.message)
		throw err
	}
}
