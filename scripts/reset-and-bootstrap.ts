#!/usr/bin/env bun
/**
 * Drop the target database (named in DATABASE_URL) and trigger the same bootstrap
 * the web tier runs at boot: ensure-exists → migrate → seed → register handlers.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun scripts/reset-and-bootstrap.ts
 */

import postgres from 'postgres'

// Disable the in-process worker + scheduler so this script exits after bootstrap.
process.env.JOBS_WORKER_ENABLED = '0'
process.env.JOBS_SCHEDULER_ENABLED = '0'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	console.error('DATABASE_URL is not set')
	process.exit(1)
}

const targetUrl = new URL(databaseUrl)
const targetDb = decodeURIComponent(targetUrl.pathname.replace(/^\/+/, ''))
if (!targetDb) {
	console.error('DATABASE_URL must include a database name')
	process.exit(1)
}

const adminUrl = new URL(databaseUrl)
adminUrl.pathname = '/postgres'

console.log(`[reset] Target database: ${targetDb}`)

const adminClient = postgres(adminUrl.toString(), { max: 1, prepare: false })
try {
	console.log(`[reset] Terminating active connections to ${targetDb}…`)
	await adminClient`
		SELECT pg_terminate_backend(pid)
		FROM pg_stat_activity
		WHERE datname = ${targetDb} AND pid <> pg_backend_pid()
	`

	console.log(`[reset] Dropping database ${targetDb}…`)
	await adminClient.unsafe(`DROP DATABASE IF EXISTS "${targetDb.replaceAll('"', '""')}"`)
	console.log(`[reset] Dropped ${targetDb}`)
} finally {
	await adminClient.end({ timeout: 5 })
}

console.log(`[reset] Loading db.server (this triggers create + migrate + seed)…`)
const { ensureDatabaseReady } = await import('../src/lib/db.server.ts')
await ensureDatabaseReady()
console.log(`[reset] ${targetDb} ready.`)
process.exit(0)
