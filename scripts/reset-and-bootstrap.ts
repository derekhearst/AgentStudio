#!/usr/bin/env bun
/**
 * Drop the target database (named in DATABASE_URL) and trigger the same bootstrap
 * the web tier runs at boot: ensure-exists → migrate → seed → register handlers.
 *
 * Only disposable databases can be reset: the name must end in dev, test or ci and must
 * not contain "prod" (the `agentstudio<env>` rule in docs/database/database.md#databases).
 * Dev and prod share one Postgres server and one role, and a shell-exported DATABASE_URL
 * overrides `.env`, so one stale variable was all it would take to drop production. There
 * is no override flag on purpose; rename the database or use psql if you really mean it.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun scripts/reset-and-bootstrap.ts
 */

import postgres from 'postgres'
import {
	getBootstrapDatabaseUrl,
	getTargetDatabaseName,
	isDisposableDatabaseName,
	quoteIdentifier,
} from '../src/lib/db/migrations.server.ts'

// Disable the in-process worker + scheduler so this script exits after bootstrap.
process.env.JOBS_WORKER_ENABLED = '0'
process.env.JOBS_SCHEDULER_ENABLED = '0'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	console.error('DATABASE_URL is not set')
	process.exit(1)
}

let targetDb: string
let targetHost: string
try {
	targetDb = getTargetDatabaseName(databaseUrl)
	targetHost = new URL(databaseUrl).host
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}

// Checked before any connection is opened.
if (!isDisposableDatabaseName(targetDb)) {
	console.error(
		`[reset] Refusing to drop "${targetDb}" on ${targetHost}: db:reset only drops databases whose name ends in dev, test or ci, and never one whose name contains "prod". See docs/database/database.md#databases.`,
	)
	process.exit(1)
}

console.log(`[reset] Target database: ${targetDb} on ${targetHost}`)

const adminClient = postgres(getBootstrapDatabaseUrl(databaseUrl), { max: 1, prepare: false })
try {
	console.log(`[reset] Terminating active connections to ${targetDb}…`)
	await adminClient`
		SELECT pg_terminate_backend(pid)
		FROM pg_stat_activity
		WHERE datname = ${targetDb} AND pid <> pg_backend_pid()
	`

	console.log(`[reset] Dropping database ${targetDb}…`)
	await adminClient.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDb)}`)
	console.log(`[reset] Dropped ${targetDb}`)
} finally {
	await adminClient.end({ timeout: 5 })
}

console.log(`[reset] Loading db.server (this triggers create + migrate + seed)…`)
const { ensureDatabaseReady } = await import('../src/lib/db.server.ts')
try {
	await ensureDatabaseReady()
} catch (err) {
	console.error(`[reset] Bootstrap of ${targetDb} failed:`, err)
	process.exit(1)
}
console.log(`[reset] ${targetDb} ready.`)
process.exit(0)
