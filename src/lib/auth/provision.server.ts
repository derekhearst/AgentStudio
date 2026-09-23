import { eq, isNotNull, isNull } from 'drizzle-orm'
import { authSessions, users } from '$lib/auth/auth.schema'
import { hashPassword } from '$lib/auth/password.server'
import { DEFAULT_OWNER_NAME, DEFAULT_OWNER_USERNAME, MIN_PASSWORD_LENGTH, validateUsername } from '$lib/auth/username'
import { getOwnerBootstrapConfig } from '$lib/server/config'
// Type-only: importing `$lib/db.server` for real would deadlock the boot pipeline, which
// calls this module while db.server.ts is still loading (see the note in db.server.ts).
import type { db as appDb } from '$lib/db.server'

/**
 * Creating the one owner account — the only thing an instance needs before it is usable.
 *
 * Three callers, one implementation:
 *   - the `/setup` form (`setupCommand`), on first run;
 *   - the boot pipeline, from `AUTH_PASSWORD` (`provisionOwnerFromEnv` below);
 *   - `bun run db:bootstrap`, for a local instance without a browser.
 *
 * Every caller passes the database handle in. The boot pipeline runs before `db.server.ts`
 * has finished loading, so this module must not import it.
 */

/** Anything with drizzle's `select` / `insert` / `update` / `delete` — the app's handle, a transaction, or the boot pipeline's. */
export type ProvisionDb = Pick<typeof appDb, 'select' | 'insert' | 'update' | 'delete'>

export type OwnerInput = {
	name?: string
	username?: string
	password: string
}

export type ProvisionResult = {
	userId: string
	/** This call gave the instance its owner (a new row, or a row that had no password). */
	created: boolean
	/** This call wrote a password hash — true when created, or when an existing one was overwritten. */
	passwordSet: boolean
}

/**
 * Give the instance an owner, race-safely.
 *
 * With `overwrite: false` (setup, boot) an existing owner is never touched: the result says
 * `created: false` and the caller decides what that means ("Setup already completed", or
 * nothing at all at boot). With `overwrite: true` (`db:bootstrap --reset-password`) an
 * existing owner's password is replaced and nothing else about the account changes.
 *
 * Whenever this sets a password on an account that already existed — a claim or an
 * overwrite — it also ends every session that account had. Both are how a lost or leaked
 * password is recovered, and a session opened with the old password must not outlive it.
 * (Setup signs its visitor in afresh straight after.)
 *
 * The write is two statements that each decide atomically, so two setup submissions at the
 * same moment cannot both win — the old code checked, then wrote, and both got a session:
 *
 *   1. Claim a row that exists but has no password (a half-finished setup, or an owner
 *      whose password an operator cleared to reopen setup). Keeping that row keeps its id,
 *      and so every conversation, run and setting that belongs to it — and its name and
 *      username too, unless the caller gave new ones. A concurrent claim waits on the row
 *      lock, re-reads it, finds a password, and matches nothing.
 *   2. Otherwise insert, ON CONFLICT DO NOTHING. The `users_singleton` unique index lets
 *      exactly one insert through; the loser inserts nothing. (No conflict target on
 *      purpose: inferring an expression index is fragile, and any conflict here means
 *      "there is already a row".)
 */
export async function provisionOwner(
	database: ProvisionDb,
	input: OwnerInput,
	options: { overwrite?: boolean } = {},
): Promise<ProvisionResult> {
	const overwrite = options.overwrite ?? false

	// The cheap check first, so an instance that already has an owner does not pay for an
	// Argon2 hash on every boot. The writes below still decide atomically.
	if (!overwrite) {
		const existing = await findOwnerId(database)
		if (existing) return { userId: existing, created: false, passwordSet: false }
	}

	if (input.password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
	}
	// Only what the caller actually supplied. A new owner falls back to the defaults; a claimed
	// row keeps its own name and username, so recovering through `AUTH_PASSWORD` with no
	// `AUTH_OWNER_NAME` does not quietly rename the owner to "Owner".
	const name = input.name?.trim() || undefined
	const username = input.username?.trim() ? validateUsername(input.username.trim()) : undefined
	const passwordHash = await hashPassword(input.password)

	const [claimed] = await database
		.update(users)
		.set({ passwordHash, ...(name ? { name } : {}), ...(username ? { username } : {}) })
		.where(isNull(users.passwordHash))
		.returning({ id: users.id })
	if (claimed) {
		await endSessionsOf(database, claimed.id)
		return { userId: claimed.id, created: true, passwordSet: true }
	}

	const [inserted] = await database
		.insert(users)
		.values({ name: name ?? DEFAULT_OWNER_NAME, username: username ?? DEFAULT_OWNER_USERNAME, passwordHash })
		.onConflictDoNothing()
		.returning({ id: users.id })
	if (inserted) return { userId: inserted.id, created: true, passwordSet: true }

	if (overwrite) {
		// The table holds one row, so no WHERE: this is "the owner's password".
		const [reset] = await database.update(users).set({ passwordHash }).returning({ id: users.id })
		if (reset) {
			await endSessionsOf(database, reset.id)
			return { userId: reset.id, created: false, passwordSet: true }
		}
	}

	const existing = await findOwnerId(database)
	if (!existing) throw new Error('Could not create the owner account')
	return { userId: existing, created: false, passwordSet: false }
}

async function endSessionsOf(database: ProvisionDb, userId: string): Promise<void> {
	await database.delete(authSessions).where(eq(authSessions.userId, userId))
}

async function findOwnerId(database: ProvisionDb): Promise<string | null> {
	const [row] = await database.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1)
	return row?.id ?? null
}

/**
 * The value `.env.example` ships for `AUTH_PASSWORD`. An instance deployed from an
 * unedited copy would otherwise come up with an owner whose password is in the repository,
 * which is worse than no owner: the first visitor would simply sign in.
 */
export const PLACEHOLDER_AUTH_PASSWORD = 'change-me'

export type EnvProvisionOutcome =
	| { status: 'not-configured' }
	| { status: 'placeholder' }
	| { status: 'kept'; userId: string }
	| { status: 'created'; userId: string; username: string }

/**
 * The boot step: create the owner from `AUTH_PASSWORD` if there is none yet.
 *
 * Never overwrites — an owner who changed their password keeps it across restarts. Then
 * removes `AUTH_PASSWORD` from `env` whatever happened. The Agent SDK's CLI no longer sees
 * it either way (it gets an allow-listed environment, `$lib/engine/engine-env`), but the
 * server's other child processes (the `git` calls, for one) still inherit `process.env`,
 * and a plaintext password has no reason to be there. The server never needs it again; the
 * test suite reads it from its own process.
 */
export async function provisionOwnerFromEnv(
	database: ProvisionDb,
	env: Record<string, string | undefined> = process.env,
): Promise<EnvProvisionOutcome> {
	try {
		const config = getOwnerBootstrapConfig(env)
		if (!config) return { status: 'not-configured' }
		if (config.password === PLACEHOLDER_AUTH_PASSWORD) return { status: 'placeholder' }

		const result = await provisionOwner(database, config, { overwrite: false })
		if (!result.created) return { status: 'kept', userId: result.userId }
		// Read back rather than assumed: a claimed row keeps its own username.
		const [owner] = await database
			.select({ username: users.username })
			.from(users)
			.where(eq(users.id, result.userId))
			.limit(1)
		return {
			status: 'created',
			userId: result.userId,
			username: owner?.username ?? config.username?.trim() ?? DEFAULT_OWNER_USERNAME,
		}
	} finally {
		delete env.AUTH_PASSWORD
	}
}
