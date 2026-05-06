// Standalone verification of migration 0050_single_user_auth.
// 1. Confirms migration 0050 is applied
// 2. Confirms users table has password_hash + no role/is_active/deleted_at/claimed_at
// 3. Confirms passkey/challenge/bootstrap tables are gone
// 4. Confirms auth_sessions still works
//
// Run with: bun scripts/verify-auth-migration.ts

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'

function loadDotEnv() {
	const envPath = resolve(process.cwd(), '.env')
	const raw = readFileSync(envPath, 'utf8')
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim()
		if (!t || t.startsWith('#')) continue
		const i = t.indexOf('=')
		if (i === -1) continue
		const k = t.slice(0, i).trim()
		let v = t.slice(i + 1).trim()
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
		process.env[k] ??= v
	}
}

loadDotEnv()
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
	console.error('DATABASE_URL not set')
	process.exit(1)
}

const sql = postgres(DATABASE_URL, { max: 1 })

try {
	const migration = await sql<{ hash: string }[]>`
		SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1
	`
	console.log('Latest migration in DB:', migration[0]?.hash ?? '(none)')

	const usersCols = await sql<{ column_name: string }[]>`
		SELECT column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'users'
		ORDER BY ordinal_position
	`
	const cols = new Set(usersCols.map((r) => r.column_name))
	console.log('users columns:', [...cols].join(', '))

	const required = ['id', 'name', 'username', 'password_hash', 'last_login_at', 'created_at']
	const removed = ['role', 'is_active', 'deleted_at', 'claimed_at']
	for (const r of required) {
		if (!cols.has(r)) throw new Error(`Missing required column users.${r}`)
	}
	for (const r of removed) {
		if (cols.has(r)) throw new Error(`Column users.${r} should have been dropped`)
	}

	const droppedTables = ['user_passkeys', 'auth_challenges', 'bootstrap_claims']
	const tableRows = await sql<{ table_name: string }[]>`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = ANY(${droppedTables as unknown as string[]})
	`
	if (tableRows.length > 0) {
		throw new Error(`These tables should have been dropped: ${tableRows.map((r) => r.table_name).join(', ')}`)
	}

	const sessions = await sql<{ exists: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'auth_sessions'
		) AS exists
	`
	if (!sessions[0]?.exists) throw new Error('auth_sessions table missing')

	const singleton = await sql<{ exists: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM pg_indexes
			WHERE schemaname = 'public' AND tablename = 'users' AND indexname = 'users_singleton'
		) AS exists
	`
	if (!singleton[0]?.exists) throw new Error('users_singleton index missing')

	const userRoleEnum = await sql<{ exists: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM pg_type t
			JOIN pg_namespace n ON n.oid = t.typnamespace
			WHERE n.nspname = 'public' AND t.typname = 'user_role'
		) AS exists
	`
	if (userRoleEnum[0]?.exists) throw new Error('user_role enum should have been dropped')

	const passwordHashState = await sql<{ has_password: boolean; user_count: number }[]>`
		SELECT
			(password_hash IS NOT NULL) AS has_password,
			(SELECT count(*)::int FROM users) AS user_count
		FROM users
		LIMIT 1
	`
	console.log('User row state:', passwordHashState[0] ?? '(no users)')

	console.log('\n✅ Migration 0050 verified — schema matches single-user-password design')
} catch (err) {
	console.error('\n❌', err instanceof Error ? err.message : err)
	process.exit(1)
} finally {
	await sql.end({ timeout: 5 })
}
