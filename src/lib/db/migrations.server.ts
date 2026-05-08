/**
 * Drizzle migration helpers — pure logic extracted from `db.server.ts`.
 *
 * These functions take a postgres-js client (or the dot-path to read local
 * migration files) so they don't depend on the singleton `db` export, avoiding
 * the import cycle that would otherwise force them to live in `db.server.ts`.
 *
 * The orchestrator in `db.server.ts` composes these helpers into the
 * `bootstrapDatabase` flow: ensure DB exists → reconcile legacy schema state →
 * install required extensions → run pending migrations.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type postgres from 'postgres'

export const MIGRATIONS_SCHEMA = 'drizzle'
export const MIGRATIONS_TABLE = '__drizzle_migrations'

/**
 * Postgres notice codes we want the bootstrap to silence rather than log.
 *   - 01000: warning (`CREATE EXTENSION IF NOT EXISTS` already-exists noise)
 *   - 42710: duplicate_object
 *   - 42P06: duplicate_schema
 *   - 42P07: duplicate_table
 */
export const QUIET_DB_NOTICE_CODES = new Set(['01000', '42710', '42P06', '42P07'])

/**
 * Postgres error codes that indicate the schema has drifted but is recoverable
 * by dropping and recreating the app schemas (development-only safety hatch —
 * never auto-recovers in production).
 */
export const RECOVERABLE_MIGRATION_ERROR_CODES = new Set([
	'42P01', // undefined_table
	'42P07', // duplicate_table
	'42701', // duplicate_column
	'42704', // undefined_object
	'42710', // duplicate_object
])

export type PostgresNotice = {
	code?: string
	message?: string
	severity?: string
	severity_local?: string
}

type PgClient = ReturnType<typeof postgres>

export function handleDatabaseNotice(notice: PostgresNotice) {
	if (notice.code && QUIET_DB_NOTICE_CODES.has(notice.code)) {
		return
	}

	const severity = notice.severity ?? notice.severity_local ?? 'NOTICE'
	const message = notice.message ?? 'PostgreSQL notice'
	console.warn(`[db] ${severity}: ${message}`)
}

export function getPostgresErrorCode(error: unknown): string | null {
	if (!error || typeof error !== 'object') {
		return null
	}

	const record = error as Record<string, unknown>
	if (typeof record.code === 'string') {
		return record.code
	}

	return getPostgresErrorCode(record.cause)
}

export function isRecoverableMigrationError(error: unknown) {
	const code = getPostgresErrorCode(error)
	return code ? RECOVERABLE_MIGRATION_ERROR_CODES.has(code) : false
}

export function getTargetDatabaseName(databaseUrl: string) {
	const parsedUrl = new URL(databaseUrl)
	const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''))

	if (!databaseName) {
		throw new Error('DATABASE_URL must include a database name')
	}

	return databaseName
}

export function getBootstrapDatabaseUrl(databaseUrl: string) {
	const parsedUrl = new URL(databaseUrl)
	parsedUrl.pathname = '/postgres'
	return parsedUrl.toString()
}

export function quoteIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`
}

export function getMigrationsFolder() {
	const migrationsFolder = resolve(process.cwd(), 'drizzle')

	if (!existsSync(migrationsFolder)) {
		throw new Error(`Drizzle migrations folder not found at ${migrationsFolder}`)
	}

	return migrationsFolder
}

export function getLatestLocalMigrationMillis() {
	const migrations = readMigrationFiles({ migrationsFolder: getMigrationsFolder() })
	return migrations.at(-1)?.folderMillis ?? null
}

/**
 * Connects to the cluster's `postgres` admin DB, checks whether the target DB
 * exists, and creates it if not. Returns true when a CREATE DATABASE was run.
 */
export async function ensureDatabaseExists(databaseUrl: string): Promise<boolean> {
	const databaseName = getTargetDatabaseName(databaseUrl)
	const postgresLib = (await import('postgres')).default
	const adminClient = postgresLib(getBootstrapDatabaseUrl(databaseUrl), {
		max: 1,
		prepare: false,
		onnotice: handleDatabaseNotice,
	})

	try {
		const existingDatabase = await adminClient<{ exists: boolean }[]>`
			SELECT EXISTS(
				SELECT 1
				FROM pg_database
				WHERE datname = ${databaseName}
			) AS "exists"
		`

		if (!existingDatabase[0]?.exists) {
			console.log(`[db] Creating database ${databaseName}`)
			// Proactively refresh template1 collation to avoid version mismatch errors
			// when the OS libc version differs from when PostgreSQL was initialized.
			await adminClient.unsafe('ALTER DATABASE template1 REFRESH COLLATION VERSION').catch(() => {
				// Not fatal — may lack superuser privileges or already be up to date
			})
			await adminClient.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
			return true
		}

		return false
	} finally {
		await adminClient.end({ timeout: 5 })
	}
}

export async function hasAppliedMigrations(client: PgClient) {
	const [migrationTable] = await client<{ exists: boolean }[]>`
		SELECT EXISTS(
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema = ${MIGRATIONS_SCHEMA}
				AND table_name = ${MIGRATIONS_TABLE}
		) AS "exists"
	`

	if (!migrationTable?.exists) {
		return false
	}

	const migrationRows = await client<{ count: number }[]>`
		SELECT COUNT(*)::int AS "count"
		FROM "drizzle"."__drizzle_migrations"
	`

	return (migrationRows[0]?.count ?? 0) > 0
}

export async function getLastAppliedMigrationMillis(client: PgClient) {
	const [migrationTable] = await client<{ exists: boolean }[]>`
		SELECT EXISTS(
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema = ${MIGRATIONS_SCHEMA}
				AND table_name = ${MIGRATIONS_TABLE}
		) AS "exists"
	`

	if (!migrationTable?.exists) {
		return null
	}

	const [row] = await client<{ createdAt: number | null }[]>`
		SELECT MAX(created_at)::bigint AS "createdAt"
		FROM "drizzle"."__drizzle_migrations"
	`

	return row?.createdAt ?? null
}

export async function hasExistingAppSchemaObjects(client: PgClient) {
	const [existingTables] = await client<{ exists: boolean }[]>`
		SELECT EXISTS(
			SELECT 1
			FROM information_schema.tables
			WHERE table_schema IN ('public', ${MIGRATIONS_SCHEMA})
				AND table_type = 'BASE TABLE'
		) AS "exists"
	`

	if (existingTables?.exists) {
		return true
	}

	const [existingEnums] = await client<{ exists: boolean }[]>`
		SELECT EXISTS(
			SELECT 1
			FROM pg_type types
			INNER JOIN pg_namespace namespaces ON namespaces.oid = types.typnamespace
			WHERE namespaces.nspname = 'public'
				AND types.typtype = 'e'
		) AS "exists"
	`

	return existingEnums?.exists ?? false
}

export async function resetAppSchemas(client: PgClient) {
	console.warn(
		'[db] No Drizzle migrations were recorded; resetting existing app schemas before applying bundled migrations',
	)
	await client.unsafe(`DROP SCHEMA IF EXISTS ${MIGRATIONS_SCHEMA} CASCADE`)
	await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
	await client.unsafe('CREATE SCHEMA public')
}

/**
 * If migrations have never been applied yet but the target DB has app tables/enums,
 * the schema is unmanaged legacy state — drop the app schemas so the bundled
 * migrations can apply from scratch. Returns true when a reset happened.
 */
export async function reconcileLegacySchemaState(client: PgClient): Promise<boolean> {
	const migrationsApplied = await hasAppliedMigrations(client)
	if (migrationsApplied) {
		return false
	}

	const hasExistingSchema = await hasExistingAppSchemaObjects(client)
	if (!hasExistingSchema) {
		return false
	}

	await resetAppSchemas(client)
	return true
}

export async function ensureRequiredExtensions(client: PgClient) {
	await client.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto')
	await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector')
	await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${MIGRATIONS_SCHEMA}`)
}
