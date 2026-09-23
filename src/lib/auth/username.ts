/**
 * The owner's username and display-name rules, with no database or SvelteKit imports so the
 * provisioning code (which the boot pipeline and scripts run) and the specs can share them.
 *
 * Nobody types the username to sign in — the login form asks only for the password — so
 * first run no longer asks for one either. It defaults to `owner` and can be set at setup
 * under "Advanced", with `AUTH_OWNER_USERNAME`, or with `bun run db:bootstrap --username`.
 */

export const DEFAULT_OWNER_USERNAME = 'owner'
export const DEFAULT_OWNER_NAME = 'Owner'
export const MIN_PASSWORD_LENGTH = 8

export function normalizeUsername(input: string) {
	return input.trim()
}

export function validateUsername(input: string) {
	const normalized = normalizeUsername(input)
	if (!/^[a-zA-Z0-9_-]{3,32}$/.test(normalized)) {
		throw new Error('Username must contain only letters, numbers, underscore, or hyphen')
	}
	return normalized
}
