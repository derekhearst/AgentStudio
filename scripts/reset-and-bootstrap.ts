#!/usr/bin/env bun
/**
 * Drop the target database (named in DATABASE_URL) and trigger the same bootstrap
 * the web tier runs at boot: ensure-exists → migrate → owner from AUTH_PASSWORD → seed →
 * register handlers.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun scripts/reset-and-bootstrap.ts
 *
 * `bun run db:bootstrap --reset` does the same and then reports the owner and sandbox.
 */

import { databaseNameOf, dropDatabase } from './drop-database'

// Disable the in-process worker + scheduler so this script exits after bootstrap.
process.env.JOBS_WORKER_ENABLED = '0'
process.env.JOBS_SCHEDULER_ENABLED = '0'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	console.error('DATABASE_URL is not set')
	process.exit(1)
}

let targetDb: string
try {
	targetDb = databaseNameOf(databaseUrl)
} catch (err) {
	console.error(err instanceof Error ? err.message : err)
	process.exit(1)
}

console.log(`[reset] Target database: ${targetDb}`)
await dropDatabase(databaseUrl, (line) => console.log(`[reset] ${line}`))

console.log(`[reset] Loading db.server (this triggers create + migrate + seed)…`)
const { ensureDatabaseReady } = await import('../src/lib/db.server.ts')
await ensureDatabaseReady()
console.log(`[reset] ${targetDb} ready.`)
process.exit(0)
