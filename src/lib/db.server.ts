import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { building } from '$app/environment'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { env } from '$env/dynamic/private'
import * as authSchema from '$lib/auth/auth.schema'
import * as chatSchema from '$lib/chat/chat.schema'
import * as memorySchema from '$lib/memory/memory.schema'
import * as palaceSchema from '$lib/memory/palace.schema'
import * as agentsSchema from '$lib/agents/agents.schema'
import * as notificationsSchema from '$lib/notifications/notifications.schema'
import * as settingsSchema from '$lib/settings/settings.schema'
import * as activitySchema from '$lib/activity/activity.schema'
import * as artifactsSchema from '$lib/artifacts/artifacts.schema'
import * as llmUsageSchema from '$lib/cost/usage.schema'
import * as skillsSchema from '$lib/skills/skills.schema'
import * as automationSchema from '$lib/automation/automation.schema'
import { readMigrationFiles } from 'drizzle-orm/migrator'

const databaseUrl = env.DATABASE_URL
const skipDatabaseInitialization = building

const schema = {
	...authSchema,
	...chatSchema,
	...memorySchema,
	...palaceSchema,
	...agentsSchema,
	...notificationsSchema,
	...settingsSchema,
	...activitySchema,
	...artifactsSchema,
	...llmUsageSchema,
	...skillsSchema,
	...automationSchema,
}

const MIGRATIONS_SCHEMA = 'drizzle'
const MIGRATIONS_TABLE = '__drizzle_migrations'

const QUIET_DB_NOTICE_CODES = new Set(['01000', '42710', '42P06', '42P07'])

type PostgresNotice = {
	code?: string
	message?: string
	severity?: string
	severity_local?: string
}

function handleDatabaseNotice(notice: PostgresNotice) {
	if (notice.code && QUIET_DB_NOTICE_CODES.has(notice.code)) {
		return
	}

	const severity = notice.severity ?? notice.severity_local ?? 'NOTICE'
	const message = notice.message ?? 'PostgreSQL notice'
	console.warn(`[db] ${severity}: ${message}`)
}

function createDatabaseClient(url: string) {
	return postgres(url, {
		onnotice: handleDatabaseNotice,
	})
}

function createDatabase(connection: ReturnType<typeof createDatabaseClient>) {
	return drizzle(connection, { schema })
}

type Database = ReturnType<typeof createDatabase>

function createUnavailableDatabase(): Database {
	return new Proxy(
		{},
		{
			get() {
				throw new Error('Database is unavailable during build because DATABASE_URL is not set')
			},
		},
	) as Database
}

if (!databaseUrl && !skipDatabaseInitialization) {
	throw new Error('DATABASE_URL is not set')
}

const client = skipDatabaseInitialization ? null : createDatabaseClient(databaseUrl!)

function getRuntimeClient() {
	if (!client) {
		throw new Error('Database client is unavailable because DATABASE_URL is not set')
	}

	return client
}

function getTargetDatabaseName(databaseUrl: string) {
	const parsedUrl = new URL(databaseUrl)
	const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''))

	if (!databaseName) {
		throw new Error('DATABASE_URL must include a database name')
	}

	return databaseName
}

function getBootstrapDatabaseUrl(databaseUrl: string) {
	const parsedUrl = new URL(databaseUrl)
	parsedUrl.pathname = '/postgres'
	return parsedUrl.toString()
}

function quoteIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`
}

async function ensureDatabaseExists(databaseUrl: string) {
	const databaseName = getTargetDatabaseName(databaseUrl)
	const adminClient = postgres(getBootstrapDatabaseUrl(databaseUrl), {
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

function getMigrationsFolder() {
	const migrationsFolder = resolve(process.cwd(), 'drizzle')

	if (!existsSync(migrationsFolder)) {
		throw new Error(`Drizzle migrations folder not found at ${migrationsFolder}`)
	}

	return migrationsFolder
}

async function hasAppliedMigrations() {
	const runtimeClient = getRuntimeClient()
	const [migrationTable] = await runtimeClient<{ exists: boolean }[]>`
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

	const migrationRows = await runtimeClient<{ count: number }[]>`
		SELECT COUNT(*)::int AS "count"
		FROM "drizzle"."__drizzle_migrations"
	`

	return (migrationRows[0]?.count ?? 0) > 0
}

async function getLastAppliedMigrationMillis() {
	const runtimeClient = getRuntimeClient()

	const [migrationTable] = await runtimeClient<{ exists: boolean }[]>`
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

	const [row] = await runtimeClient<{ createdAt: number | null }[]>`
		SELECT MAX(created_at)::bigint AS "createdAt"
		FROM "drizzle"."__drizzle_migrations"
	`

	return row?.createdAt ?? null
}

function getLatestLocalMigrationMillis() {
	const migrations = readMigrationFiles({ migrationsFolder: getMigrationsFolder() })
	return migrations.at(-1)?.folderMillis ?? null
}

async function hasExistingAppSchemaObjects() {
	const runtimeClient = getRuntimeClient()
	const [existingTables] = await runtimeClient<{ exists: boolean }[]>`
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

	const [existingEnums] = await runtimeClient<{ exists: boolean }[]>`
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

async function resetAppSchemas() {
	const runtimeClient = getRuntimeClient()
	console.warn(
		'[db] No Drizzle migrations were recorded; resetting existing app schemas before applying bundled migrations',
	)
	await runtimeClient.unsafe(`DROP SCHEMA IF EXISTS ${MIGRATIONS_SCHEMA} CASCADE`)
	await runtimeClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
	await runtimeClient.unsafe('CREATE SCHEMA public')
}

async function reconcileLegacySchemaState() {
	const migrationsApplied = await hasAppliedMigrations()
	if (migrationsApplied) {
		return false
	}

	const hasExistingSchema = await hasExistingAppSchemaObjects()
	if (!hasExistingSchema) {
		return false
	}

	await resetAppSchemas()
	return true
}

async function ensureRequiredExtensions() {
	const runtimeClient = getRuntimeClient()
	await runtimeClient.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto')
	await runtimeClient.unsafe('CREATE EXTENSION IF NOT EXISTS vector')
	await runtimeClient.unsafe(`CREATE SCHEMA IF NOT EXISTS ${MIGRATIONS_SCHEMA}`)
}

async function bootstrapDatabase() {
	if (!client || !databaseUrl) {
		return
	}

	try {
		const createdDatabase = await ensureDatabaseExists(databaseUrl)
		const resetLegacySchema = await reconcileLegacySchemaState()
		await ensureRequiredExtensions()

		const latestLocalMigrationMillis = getLatestLocalMigrationMillis()
		const lastAppliedMigrationMillis = await getLastAppliedMigrationMillis()
		const hasPendingMigrations =
			latestLocalMigrationMillis !== null &&
			(lastAppliedMigrationMillis === null || lastAppliedMigrationMillis < latestLocalMigrationMillis)

		if (createdDatabase || resetLegacySchema || hasPendingMigrations) {
			console.log('[db] Applying migrations')
		}

		const bootstrapDb = createDatabase(client)
		await migrate(bootstrapDb, {
			migrationsFolder: getMigrationsFolder(),
			migrationsSchema: MIGRATIONS_SCHEMA,
			migrationsTable: MIGRATIONS_TABLE,
		})

		if (createdDatabase || resetLegacySchema || hasPendingMigrations) {
			console.log('[db] Database bootstrapped and ready')
		} else {
			console.log('[db] Database ready')
		}
	} catch (err) {
		console.error('[db] Bootstrap failed — database may be unavailable:', err)
	}
}

const databaseReadyPromise = skipDatabaseInitialization ? Promise.resolve() : bootstrapDatabase()

export async function ensureDatabaseReady() {
	await databaseReadyPromise
}

await databaseReadyPromise

export const db: Database = client ? createDatabase(client) : createUnavailableDatabase()
