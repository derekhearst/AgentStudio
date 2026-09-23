#!/usr/bin/env bun
/**
 * Provision a local AgentStudio instance without a browser: database, owner account and
 * sandbox folder, in one idempotent command.
 *
 *   bun run db:bootstrap                    create what is missing; change nothing that exists
 *   bun run db:bootstrap --reset            drop the database first (everything in it is lost)
 *   bun run db:bootstrap --reset-password   set the owner's password even if one exists
 *
 * Options:
 *   --password <pw>   the owner's password. Defaults to AUTH_PASSWORD (from .env), which is
 *                     the better place for it: a command-line argument lands in shell history.
 *   --name <name>     display name for a new owner (default AUTH_OWNER_NAME, else "Owner")
 *   --username <u>    username for a new owner (default AUTH_OWNER_USERNAME, else "owner")
 *
 * Runs the same boot pipeline the web server does (create → migrate → seed) with the job
 * worker and scheduler off, then creates the owner, then makes sure SANDBOX_WORKSPACE
 * exists. It prints the database, the owner's username, whether the password was set or
 * kept, and the sandbox root — never the password.
 *
 * Development and CI only: it refuses to run with NODE_ENV=production, and the production
 * image does not ship scripts/. A production instance gets its owner from AUTH_PASSWORD at
 * boot, or from /setup.
 */

import { mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { databaseNameOf, dropDatabase } from './drop-database'

if (process.env.NODE_ENV === 'production') {
	console.error('[bootstrap] Refusing to run with NODE_ENV=production — this script is for development and CI.')
	process.exit(1)
}

const { values: args } = parseArgs({
	options: {
		reset: { type: 'boolean', default: false },
		'reset-password': { type: 'boolean', default: false },
		password: { type: 'string' },
		name: { type: 'string' },
		username: { type: 'string' },
		help: { type: 'boolean', short: 'h', default: false },
	},
	strict: true,
})

if (args.help) {
	console.log('Usage: bun run db:bootstrap [--reset] [--reset-password] [--password <pw>] [--name <name>] [--username <u>]')
	process.exit(0)
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	console.error('[bootstrap] DATABASE_URL is not set (put it in .env).')
	process.exit(1)
}

const password = args.password ?? process.env.AUTH_PASSWORD?.trim()
if (!password) {
	console.error('[bootstrap] No password: set AUTH_PASSWORD in .env, or pass --password.')
	process.exit(1)
}

// This script creates the owner itself, with its own flags. Blank AUTH_PASSWORD (not delete:
// db.server.ts reloads .env into any variable that is *unset*) so the boot pipeline's own
// "owner from AUTH_PASSWORD" step does not get there first and leave nothing to report.
process.env.AUTH_PASSWORD = ''
// Bootstrap once and exit; no job worker or scheduler.
process.env.JOBS_WORKER_ENABLED = '0'
process.env.JOBS_SCHEDULER_ENABLED = '0'

const targetDb = databaseNameOf(databaseUrl)
console.log(`[bootstrap] Database: ${targetDb}`)

if (args.reset) {
	await dropDatabase(databaseUrl, (line) => console.log(`[bootstrap] ${line}`))
}

try {
	const { db, ensureDatabaseReady } = await import('../src/lib/db.server.ts')
	await ensureDatabaseReady()

	const { PLACEHOLDER_AUTH_PASSWORD, provisionOwner } = await import('../src/lib/auth/provision.server.ts')
	const { getSandboxRoot } = await import('../src/lib/server/config.ts')
	const { users } = await import('../src/lib/auth/auth.schema.ts')
	const { eq } = await import('drizzle-orm')

	const result = await provisionOwner(
		db,
		{
			password,
			name: args.name ?? process.env.AUTH_OWNER_NAME,
			username: args.username ?? process.env.AUTH_OWNER_USERNAME,
		},
		{ overwrite: args['reset-password'] },
	)
	const [owner] = await db.select({ username: users.username }).from(users).where(eq(users.id, result.userId))

	const sandboxRoot = getSandboxRoot()
	await mkdir(sandboxRoot, { recursive: true })

	const passwordState = result.created
		? 'set'
		: result.passwordSet
			? 'reset (every existing session was signed out)'
			: 'kept (the owner already had one)'
	console.log(`[bootstrap] Owner:    ${owner?.username ?? '(unknown)'}`)
	console.log(`[bootstrap] Password: ${passwordState}`)
	console.log(`[bootstrap] Sandbox:  ${sandboxRoot}`)
	if (!result.created && (args.name || args.username)) {
		console.log('[bootstrap] --name/--username apply only when the owner is created; the existing owner was left as is.')
	}
	if (result.passwordSet && password === PLACEHOLDER_AUTH_PASSWORD) {
		console.warn('[bootstrap] That is the .env.example placeholder password. Fine on this machine; never on a reachable one.')
	}
	console.log(
		result.passwordSet
			? '[bootstrap] Ready. Start the app with `bun run dev` and sign in with that password.'
			: '[bootstrap] Ready. The existing password still applies; pass --reset-password to replace it.',
	)
	process.exit(0)
} catch (err) {
	console.error('[bootstrap] Failed:', err instanceof Error ? err.message : err)
	process.exit(1)
}
