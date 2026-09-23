/**
 * Drizzle migration helpers — pure logic extracted from `db.server.ts`.
 *
 * These functions take a postgres-js client (or the dot-path to read local
 * migration files) so they don't depend on the singleton `db` export, avoiding
 * the import cycle that would otherwise force them to live in `db.server.ts`.
 *
 * The orchestrator in `bootstrap.server.ts` composes these helpers into the
 * `bootstrapDatabase` flow: ensure DB exists → take the bootstrap lock → reconcile
 * legacy schema state → install required extensions → run pending migrations.
 *
 * Nothing in here drops data on its own initiative. The only destructive helper,
 * `resetAppSchemas`, is reached solely through `reconcileLegacySchemaState`, and only
 * for a positively identified AgentStudio schema with the operator's explicit opt-in.
 * Keep this module free of `$lib` imports: `scripts/drop-database.ts` (behind `db:reset`
 * and `db:bootstrap --reset`) imports it directly to run its safety guard before it
 * connects to anything.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getTableName, is } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { PgTable, isPgEnum } from 'drizzle-orm/pg-core'
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
 * Postgres error codes that usually mean the database has drifted away from the
 * migration chain: a migration expects an object that is not there, or creates one that
 * already is. Used only to word the failure message. A failed migration never triggers a
 * reset — it used to, on any non-production process, and that wiped real databases.
 */
export const SCHEMA_DRIFT_ERROR_CODES = new Set([
	'42P01', // undefined_table
	'42P07', // duplicate_table
	'42701', // duplicate_column
	'42704', // undefined_object
	'42710', // duplicate_object
])

/**
 * Environment flag that lets bootstrap drop and rebuild a legacy AgentStudio schema (one
 * with app tables but no migration history). Off unless set to exactly `1`, in every
 * environment, and meant to be set for a single boot and then removed.
 */
export const LEGACY_SCHEMA_RESET_FLAG = 'DB_ALLOW_LEGACY_SCHEMA_RESET'

/**
 * Tables every AgentStudio database has had since the first migration. A schema without
 * all of them cannot be identified as AgentStudio's, however familiar its other names.
 */
export const CORE_APP_TABLES = ['users', 'conversations', 'messages', 'agents', 'skills'] as const

/**
 * Advisory-lock key held while one process checks and migrates the schema. Any constant
 * works as long as every AgentStudio process agrees on it. It sits above the 32-bit range
 * the test helpers hash their lock names into, so the two can never collide. Advisory
 * locks are scoped to the current database, so databases sharing a server never wait on
 * each other.
 */
export const BOOTSTRAP_LOCK_KEY = 7_140_318_202

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

/**
 * The message an operator sees when the pending migrations fail. Drizzle applies every
 * pending migration in one transaction, so a failure leaves the database exactly as it
 * was — say so, because the old behaviour (drop everything and retry) is what people
 * will fear happened.
 */
export function describeMigrationFailure(error: unknown, databaseName: string): string {
	const code = getPostgresErrorCode(error)
	const detail = error instanceof Error ? error.message : String(error)
	const lines = [
		`Migrations failed on database "${databaseName}"${code ? ` (Postgres error ${code})` : ''}: ${detail}`,
		'The pending migrations ran in a single transaction and were rolled back. Nothing was applied and nothing was dropped.',
	]

	if (code && SCHEMA_DRIFT_ERROR_CODES.has(code)) {
		lines.push(
			'This usually means the database schema has drifted from the migration chain (see "Known schema drift" in docs/database/database.md).',
			'Fix the migration so it applies to the existing database. If this database is a disposable dev/test copy, `bun run db:reset` rebuilds it from scratch.',
		)
	}

	return lines.join('\n')
}

export function getTargetDatabaseName(databaseUrl: string) {
	const parsedUrl = new URL(databaseUrl)
	const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''))

	if (!databaseName) {
		throw new Error('DATABASE_URL must include a database name')
	}

	return databaseName
}

/**
 * Whether `bun run db:reset` (or `db:bootstrap --reset`) may drop this database. Names follow `agentstudio<env>`
 * (docs/database/database.md#databases): one ending in dev, test or ci is a throwaway by
 * convention. A name containing "prod" never is, whatever it ends in.
 */
export function isDisposableDatabaseName(name: string): boolean {
	const lower = name.toLowerCase()
	if (lower.includes('prod')) return false
	return /(dev|test|ci)$/.test(lower)
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
			try {
				await adminClient.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
			} catch (err) {
				// 42P04 duplicate_database: another process booting at the same moment
				// created it between our check and our CREATE. That is the outcome we wanted.
				if (getPostgresErrorCode(err) === '42P04') return false
				throw err
			}
			return true
		}

		return false
	} finally {
		await adminClient.end({ timeout: 5 })
	}
}

export type BootstrapLockOptions = {
	/** Override the lock key. Only specs use this, so they never contend with a real boot. */
	key?: number
	/** How long to wait for another process's migration before giving up. */
	timeoutMs?: number
	pollIntervalMs?: number
}

/**
 * Run `fn` while holding the bootstrap advisory lock, so only one process at a time checks
 * and migrates the schema.
 *
 * Without it, two processes booting against the same pending migration (the dev server
 * and `bun run worker`, or a web container and a worker container) both read the same
 * "last applied" row and both run the migration. The loser blocks on the winner's ALTER,
 * then fails on the objects the winner just created. The second process now waits, then
 * finds nothing pending.
 *
 * The lock lives on a dedicated one-connection client rather than the app pool: an
 * advisory lock belongs to a session, and ending that session releases it even when the
 * unlock never runs (a crash, a dropped socket).
 */
export async function withBootstrapLock<T>(
	databaseUrl: string,
	fn: () => Promise<T>,
	options: BootstrapLockOptions = {},
): Promise<T> {
	const key = String(options.key ?? BOOTSTRAP_LOCK_KEY)
	const timeoutMs = options.timeoutMs ?? 10 * 60_000
	const pollIntervalMs = options.pollIntervalMs ?? 1_000
	const postgresLib = (await import('postgres')).default
	const lockClient = postgresLib(databaseUrl, { max: 1, prepare: false, onnotice: handleDatabaseNotice })

	let acquired = false
	try {
		const deadline = Date.now() + timeoutMs
		let announcedWait = false
		for (;;) {
			const [row] = await lockClient<{ locked: boolean }[]>`
				SELECT pg_try_advisory_lock(${key}::bigint) AS "locked"
			`
			if (row?.locked) {
				acquired = true
				break
			}
			if (Date.now() >= deadline) {
				const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
				throw new Error(
					`Timed out after ${waited} waiting for another process to finish migrating the database`,
				)
			}
			if (!announcedWait) {
				announcedWait = true
				console.log('[db] Another process is migrating this database; waiting for it to finish')
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs))
		}

		return await fn()
	} finally {
		if (acquired) {
			await lockClient`SELECT pg_advisory_unlock(${key}::bigint)`.catch(() => {
				// Ending the session below releases it regardless.
			})
		}
		await lockClient.end({ timeout: 5 })
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

/** Table and enum names AgentStudio owns. */
export type KnownAppObjects = {
	tables: Set<string>
	enums: Set<string>
}

/** Tables and enums declared by the Drizzle schema (pass the aggregate `schema` object). */
export function collectSchemaObjectNames(schemaModule: Record<string, unknown>): KnownAppObjects {
	const tables = new Set<string>()
	const enums = new Set<string>()
	for (const value of Object.values(schemaModule)) {
		if (is(value, PgTable)) {
			tables.add(getTableName(value))
		} else if (isPgEnum(value)) {
			enums.add(value.enumName)
		}
	}
	return { tables, enums }
}

const CREATED_TABLE_PATTERN = /CREATE TABLE (?:IF NOT EXISTS )?(?:"public"\.)?"([^"]+)"/gi
const CREATED_ENUM_PATTERN = /CREATE TYPE (?:"public"\.)?"([^"]+)" AS ENUM/gi
const RENAMED_TABLE_PATTERN = /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:"public"\.)?"[^"]+" RENAME TO "([^"]+)"/gi
const RENAMED_TYPE_PATTERN = /ALTER TYPE (?:"public"\.)?"[^"]+" RENAME TO "([^"]+)"/gi

/**
 * Tables and enums any migration has ever created or renamed something to. This catches
 * names the current schema no longer declares — `memory_chunks`, the `*_old` enums, tables
 * later dropped — which an older AgentStudio database may still hold.
 */
export function collectMigrationObjectNames(statements: Iterable<string>): KnownAppObjects {
	const tables = new Set<string>()
	const enums = new Set<string>()
	for (const statement of statements) {
		for (const match of statement.matchAll(CREATED_TABLE_PATTERN)) tables.add(match[1])
		for (const match of statement.matchAll(RENAMED_TABLE_PATTERN)) tables.add(match[1])
		for (const match of statement.matchAll(CREATED_ENUM_PATTERN)) enums.add(match[1])
		for (const match of statement.matchAll(RENAMED_TYPE_PATTERN)) enums.add(match[1])
	}
	return { tables, enums }
}

/** Every table and enum name AgentStudio has declared or migrated, past or present. */
export function getKnownAppObjects(
	schemaModule: Record<string, unknown>,
	migrationsFolder: string = getMigrationsFolder(),
): KnownAppObjects {
	const fromSchema = collectSchemaObjectNames(schemaModule)
	const fromMigrations = collectMigrationObjectNames(
		readMigrationFiles({ migrationsFolder }).flatMap((migration) => migration.sql),
	)
	return {
		tables: new Set([...fromSchema.tables, ...fromMigrations.tables]),
		enums: new Set([...fromSchema.enums, ...fromMigrations.enums]),
	}
}

/** `type` covers domains, range types and standalone composite types. */
export type SchemaObjectKind = 'table' | 'view' | 'sequence' | 'enum' | 'type' | 'function'

/** Something a reset would destroy: a user-created object in `public` or `drizzle`. */
export type SchemaObject = {
	schema: string
	name: string
	kind: SchemaObjectKind
}

/**
 * Everything `DROP SCHEMA public/drizzle CASCADE` would destroy that someone created:
 * tables, views, standalone sequences, enums, domains and other user-defined types, and
 * functions. Anything listed that AgentStudio does not recognise blocks a reset. Left out:
 * extension members (pgvector, pgcrypto), which are reinstalled straight after a reset;
 * sequences behind a serial or identity column, which go with their table; and drizzle's
 * own bookkeeping table, which a failed first migration leaves behind empty.
 */
export async function listUnmanagedSchemaObjects(client: PgClient): Promise<SchemaObject[]> {
	return client<SchemaObject[]>`
		SELECT n.nspname AS "schema",
			c.relname AS "name",
			CASE
				WHEN c.relkind IN ('v', 'm') THEN 'view'
				WHEN c.relkind = 'S' THEN 'sequence'
				ELSE 'table'
			END AS "kind"
		FROM pg_class c
		INNER JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname IN ('public', ${MIGRATIONS_SCHEMA})
			AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
			AND NOT (n.nspname = ${MIGRATIONS_SCHEMA} AND c.relname = ${MIGRATIONS_TABLE})
			AND NOT EXISTS (
				SELECT 1 FROM pg_depend d
				WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
			)
			AND NOT (
				c.relkind = 'S'
				AND EXISTS (
					SELECT 1 FROM pg_depend d
					WHERE d.classid = 'pg_class'::regclass
						AND d.objid = c.oid
						AND d.refclassid = 'pg_class'::regclass
						AND d.deptype IN ('a', 'i')
				)
			)
		UNION ALL
		SELECT n.nspname, t.typname, CASE WHEN t.typtype = 'e' THEN 'enum' ELSE 'type' END
		FROM pg_type t
		INNER JOIN pg_namespace n ON n.oid = t.typnamespace
		LEFT JOIN pg_class r ON r.oid = t.typrelid
		WHERE n.nspname IN ('public', ${MIGRATIONS_SCHEMA})
			-- Composite types are only listed when standalone: every table has one too.
			AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND r.relkind = 'c'))
			AND NOT EXISTS (
				SELECT 1 FROM pg_depend d
				WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
			)
		UNION ALL
		SELECT n.nspname, p.proname, 'function'
		FROM pg_proc p
		INNER JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname IN ('public', ${MIGRATIONS_SCHEMA})
			AND NOT EXISTS (
				SELECT 1 FROM pg_depend d
				WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
			)
		ORDER BY 1, 3, 2
	`
}

export type LegacySchemaPlan =
	| { action: 'none' }
	| { action: 'reset'; tables: string[] }
	| { action: 'refuse'; reason: string }

export type LegacySchemaInput = {
	databaseName: string
	migrationsApplied: boolean
	objects: SchemaObject[]
	known: KnownAppObjects
	allowReset: boolean
}

const MAX_LISTED_OBJECTS = 15

function formatObjectList(objects: SchemaObject[]) {
	const shown = objects.slice(0, MAX_LISTED_OBJECTS).map((o) => `${o.kind} ${o.schema}.${o.name}`)
	const more = objects.length > MAX_LISTED_OBJECTS ? `, and ${objects.length - MAX_LISTED_OBJECTS} more` : ''
	return `${shown.join(', ')}${more}`
}

/**
 * Decide what to do with a database that has no migration history. Pure, so every branch
 * is testable without a database.
 *
 *   - Nothing user-created in `public`/`drizzle` → nothing to do; migrations build it.
 *   - Anything AgentStudio does not recognise, or AgentStudio's core tables missing →
 *     refuse. It may be another application's data, and the only thing bootstrap could do
 *     next is `DROP SCHEMA public CASCADE`.
 *   - A positively identified AgentStudio schema → reset only with
 *     `DB_ALLOW_LEGACY_SCHEMA_RESET=1`. It could be a restore of real data (a `pg_dump -n
 *     public` backup leaves out the `drizzle` schema), so wiping it needs a human.
 */
export function planLegacySchemaReconcile(input: LegacySchemaInput): LegacySchemaPlan {
	const { databaseName, migrationsApplied, objects, known, allowReset } = input

	if (migrationsApplied || objects.length === 0) {
		return { action: 'none' }
	}

	const isKnown = (object: SchemaObject) =>
		object.schema === 'public' &&
		((object.kind === 'table' && known.tables.has(object.name)) ||
			(object.kind === 'enum' && known.enums.has(object.name)))

	const unknownObjects = objects.filter((object) => !isKnown(object))
	const presentTables = new Set(
		objects.filter((o) => o.schema === 'public' && o.kind === 'table').map((o) => o.name),
	)
	const missingCoreTables = CORE_APP_TABLES.filter((table) => !presentTables.has(table))

	const pointElsewhere =
		'AgentStudio needs a database of its own: point DATABASE_URL at a new database name (bootstrap creates it) rather than one that already holds other data.'

	if (unknownObjects.length > 0) {
		return {
			action: 'refuse',
			reason: [
				`Refusing to start: database "${databaseName}" has no AgentStudio migration history, and it holds objects AgentStudio does not recognise: ${formatObjectList(unknownObjects)}.`,
				pointElsewhere,
				'Nothing was changed.',
			].join('\n'),
		}
	}

	if (missingCoreTables.length > 0) {
		return {
			action: 'refuse',
			reason: [
				`Refusing to start: database "${databaseName}" has no AgentStudio migration history, and although its tables have AgentStudio names, the core tables are missing (${missingCoreTables.join(', ')}), so it cannot be identified as an AgentStudio database.`,
				pointElsewhere,
				'Nothing was changed.',
			].join('\n'),
		}
	}

	const tables = [...presentTables].sort()

	if (!allowReset) {
		return {
			action: 'refuse',
			reason: [
				`Refusing to start: database "${databaseName}" holds an AgentStudio schema (${tables.length} tables) but no migration history, so the bundled migrations cannot be applied on top of it.`,
				'Starting would mean dropping and rebuilding its public and drizzle schemas, which deletes every row.',
				'If this is a restore of an AgentStudio backup, restore the "drizzle" schema too (a pg_dump taken with -n public leaves it out).',
				`If its data is disposable, start once with ${LEGACY_SCHEMA_RESET_FLAG}=1 and then remove the flag.`,
				'Nothing was changed.',
			].join('\n'),
		}
	}

	return { action: 'reset', tables }
}

/**
 * Drop the app schemas. Destroys every row in `public` and the migration history. The
 * only caller is `reconcileLegacySchemaState`, after `planLegacySchemaReconcile` has
 * identified the schema as AgentStudio's and the operator has opted in.
 */
export async function resetAppSchemas(client: PgClient) {
	await client.unsafe(`DROP SCHEMA IF EXISTS ${MIGRATIONS_SCHEMA} CASCADE`)
	await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
	await client.unsafe('CREATE SCHEMA public')
}

export type ReconcileLegacySchemaOptions = {
	databaseName: string
	/** Lazy, because it reads every migration file and is only needed on a database with no history. */
	getKnownObjects: () => KnownAppObjects
	allowReset: boolean
}

/**
 * If migrations have never been applied but the database already holds objects, decide
 * whether it is safe to wipe (see `planLegacySchemaReconcile`). Throws with instructions
 * when it is not. Returns true when a reset happened.
 */
export async function reconcileLegacySchemaState(
	client: PgClient,
	options: ReconcileLegacySchemaOptions,
): Promise<boolean> {
	const migrationsApplied = await hasAppliedMigrations(client)
	if (migrationsApplied) {
		return false
	}

	const objects = await listUnmanagedSchemaObjects(client)
	if (objects.length === 0) {
		return false
	}

	const plan = planLegacySchemaReconcile({
		databaseName: options.databaseName,
		migrationsApplied,
		objects,
		known: options.getKnownObjects(),
		allowReset: options.allowReset,
	})

	if (plan.action === 'none') {
		return false
	}

	if (plan.action === 'refuse') {
		throw new Error(plan.reason)
	}

	console.error(
		`[db] ${LEGACY_SCHEMA_RESET_FLAG}=1: dropping the public and drizzle schemas of "${options.databaseName}" (${plan.tables.length} AgentStudio tables, no migration history) and rebuilding them from the bundled migrations. Remove the flag after this boot.`,
	)
	await resetAppSchemas(client)
	return true
}

export async function ensureRequiredExtensions(client: PgClient) {
	await client.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto')
	await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector')
	await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${MIGRATIONS_SCHEMA}`)
}
