import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { handleDatabaseNotice } from '$lib/db/migrations.server'
import { bootstrapDatabase } from '$lib/db/bootstrap.server'

// Load .env into process.env so server modules can read directly without depending on
// SvelteKit's `$env/dynamic/private` virtual module. Bun auto-loads .env when invoking
// scripts but Vite's SSR module runner doesn't inherit that into the same evaluation
// context (we saw DATABASE_URL come back undefined during `vite dev` spawn). Explicit
// load is idempotent — already-set vars are preserved.
loadDotEnv()
function loadDotEnv() {
	try {
		const envPath = resolve(process.cwd(), '.env')
		if (!existsSync(envPath)) return
		const raw = readFileSync(envPath, 'utf8')
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const eqIndex = trimmed.indexOf('=')
			if (eqIndex === -1) continue
			const key = trimmed.slice(0, eqIndex).trim()
			let value = trimmed.slice(eqIndex + 1).trim()
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1)
			}
			if (process.env[key] === undefined) {
				process.env[key] = value
			}
		}
	} catch {
		// non-fatal — env-dependent code paths will throw with their own clearer messages
	}
}

import { schema } from '$lib/db/schema.server'

// Bootstrap detection without `$app/environment` so the module is importable from
// non-SvelteKit contexts (Playwright Node runtime, scripts, …). The `BUILD_PHASE` env
// var is set by `package.json`'s `build` script; missing/unset means runtime.
const databaseUrl = process.env.DATABASE_URL
const skipDatabaseInitialization = process.env.BUILD_PHASE === '1'

function createDatabaseClient(url: string) {
	return postgres(url, { onnotice: handleDatabaseNotice })
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

// Top-level await intentionally removed: it caused a circular ESM-await deadlock when
// bootstrap's own dynamic seeders (which transitively import db.server) waited on this
// module's load to complete. All real callers (hooks.server.ts, every remote function
// handler) already call `ensureDatabaseReady()` at the request boundary, so the promise
// is awaited at the right time without blocking the module graph.
const databaseReadyPromise =
	skipDatabaseInitialization || !client || !databaseUrl
		? Promise.resolve()
		: bootstrapDatabase({ client, databaseUrl })

export async function ensureDatabaseReady() {
	await databaseReadyPromise
}

export const db: Database = client ? createDatabase(client) : createUnavailableDatabase()
