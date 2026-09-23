#!/usr/bin/env bun
/**
 * Drop the target database (named in DATABASE_URL) and trigger the same bootstrap
 * the web tier runs at boot: ensure-exists → migrate → owner from AUTH_PASSWORD → seed →
 * register handlers.
 *
 * Only disposable databases can be reset: the name must end in dev, test or ci and must
 * not contain "prod" (the `agentstudio<env>` rule in docs/database/database.md#databases).
 * `dropDatabase` (scripts/drop-database.ts) enforces that before it opens a connection, for
 * this script and for `db:bootstrap --reset` alike.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun scripts/reset-and-bootstrap.ts
 *
 * `bun run db:bootstrap --reset` does the same and then reports the owner and sandbox.
 */

import { getTargetDatabaseName } from '../src/lib/db/migrations.server.ts'
import { dropDatabase } from './drop-database'

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
	targetDb = getTargetDatabaseName(databaseUrl)
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}

console.log(`[reset] Target database: ${targetDb}`)
try {
	await dropDatabase(databaseUrl, (line) => console.log(`[reset] ${line}`))
} catch (err) {
	console.error(`[reset] ${err instanceof Error ? err.message : String(err)}`)
	process.exit(1)
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
