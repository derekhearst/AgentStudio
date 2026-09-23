import { sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, getMigrationsFolder } from '$lib/db/migrations.server'
import { logger } from '$lib/observability/logger'

/**
 * How many migrations the running build ships against how many the database has applied.
 *
 * They match on a healthy deploy. `applied < bundled` means the build shipped a migration
 * that has not run; `applied > bundled` means the build is older than the database — the
 * partial deploy `/api/health` was written to catch (#47). Shared by the health check and
 * the Settings > System checklist so the two cannot disagree.
 */
export type MigrationStatus = {
	bundledMigrations: number | null
	appliedMigrations: number | null
	databaseReachable: boolean
	migrationsInSync: boolean
}

/** Count the migration files the running build carries, from the journal it ships. */
async function countBundledMigrations(): Promise<number | null> {
	try {
		const { readFile } = await import('node:fs/promises')
		const { join } = await import('node:path')
		const journalPath = join(getMigrationsFolder(), 'meta', '_journal.json')
		const parsed = JSON.parse(await readFile(journalPath, 'utf-8')) as { entries?: unknown[] }
		return Array.isArray(parsed.entries) ? parsed.entries.length : null
	} catch (err) {
		logger.warn('[health] could not read the migration journal', { err })
		return null
	}
}

async function countAppliedMigrations(): Promise<number | null> {
	try {
		const rows = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(MIGRATIONS_TABLE)}`,
		)
		const first = (rows as unknown as Array<{ n: number }>)[0]
		return typeof first?.n === 'number' ? first.n : null
	} catch (err) {
		logger.warn('[health] could not count applied migrations', { err })
		return null
	}
}

export async function getMigrationStatus(): Promise<MigrationStatus> {
	const [bundledMigrations, appliedMigrations] = await Promise.all([countBundledMigrations(), countAppliedMigrations()])
	return {
		bundledMigrations,
		appliedMigrations,
		databaseReachable: appliedMigrations !== null,
		migrationsInSync:
			bundledMigrations !== null && appliedMigrations !== null && bundledMigrations === appliedMigrations,
	}
}
