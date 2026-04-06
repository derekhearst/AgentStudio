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
import * as agentsSchema from '$lib/agents/agents.schema'
import * as notificationsSchema from '$lib/notifications/notifications.schema'
import * as settingsSchema from '$lib/settings/settings.schema'
import * as activitySchema from '$lib/activity/activity.schema'
import * as artifactsSchema from '$lib/artifacts/artifacts.schema'
import * as llmUsageSchema from '$lib/cost/usage.schema'
import * as skillsSchema from '$lib/skills/skills.schema'

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

const client = postgres(env.DATABASE_URL)

const schema = {
	...authSchema,
	...chatSchema,
	...memorySchema,
	...agentsSchema,
	...notificationsSchema,
	...settingsSchema,
	...activitySchema,
	...artifactsSchema,
	...llmUsageSchema,
	...skillsSchema,
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
			await adminClient.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
		}
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

async function bootstrapDatabase() {
	await ensureDatabaseExists(env.DATABASE_URL)

	console.log('[db] Ensuring required extensions are installed')
	await client.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto')
	await client.unsafe('CREATE EXTENSION IF NOT EXISTS vector')

	console.log('[db] Applying migrations')
	const bootstrapDb = drizzle(client, { schema })
	await migrate(bootstrapDb, { migrationsFolder: getMigrationsFolder() })
	console.log('[db] Database ready')
}

const databaseReadyPromise = building ? Promise.resolve() : bootstrapDatabase()

export async function ensureDatabaseReady() {
	await databaseReadyPromise
}

await databaseReadyPromise

export const db = drizzle(client, { schema })
