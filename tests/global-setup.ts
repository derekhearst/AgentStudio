import { access, constants } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import type { FullConfig } from '@playwright/test'

function readDotEnvValues() {
	const values = new Map<string, string>()
	const envPath = join(process.cwd(), '.env')

	let raw = ''
	try {
		raw = readFileSync(envPath, 'utf8')
	} catch {
		return values
	}

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eqIndex = trimmed.indexOf('=')
		if (eqIndex === -1) continue

		const key = trimmed.slice(0, eqIndex).trim()
		let value = trimmed.slice(eqIndex + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		values.set(key, value)
	}

	return values
}

function requiredEnv(name: string) {
	const value = process.env[name]?.trim() || dotenvValues.get(name)?.trim()
	if (!value) {
		throw new Error(`Missing required environment variable for real E2E run: ${name}`)
	}
	process.env[name] = value
	return value
}

const dotenvValues = readDotEnvValues()

async function ensureDbReachable(databaseUrl: string) {
	const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 })
	try {
		const rows = await sql<{ ok: number }[]>`select 1 as ok`
		if (rows[0]?.ok !== 1) {
			throw new Error('Database ping returned unexpected result')
		}
	} finally {
		await sql.end({ timeout: 5 })
	}
}

async function ensureUrlReachable(url: string, label: string) {
	const response = await fetch(url, { method: 'GET' })
	if (!response.ok) {
		throw new Error(`${label} is not reachable at ${url} (status ${response.status})`)
	}
}

async function ensureSandboxWritable(path: string) {
	await access(path, constants.R_OK | constants.W_OK)
}

export default async function globalSetup(_config: FullConfig) {
	process.env.E2E_MOCK_EXTERNALS = '0'

	const databaseUrl = requiredEnv('DATABASE_URL')
	requiredEnv('OPENROUTER_API_KEY')
	requiredEnv('AUTH_PASSWORD')
	const searxngUrl = requiredEnv('SEARXNG_URL')
	const sandboxWorkspace = requiredEnv('SANDBOX_WORKSPACE')

	await ensureDbReachable(databaseUrl)

	/**
	 * CI has no SearXNG. The database is genuinely required — almost every spec talks to
	 * it — but web search is used by a handful, and those are quarantined there anyway.
	 * Failing the whole run over an unreachable LAN service would mean no CI at all.
	 */
	if (process.env.E2E_SKIP_EXTERNAL_CHECKS === '1') {
		console.log('[global-setup] E2E_SKIP_EXTERNAL_CHECKS=1 — not checking SEARXNG_URL')
	} else {
		await ensureUrlReachable(searxngUrl, 'SEARXNG_URL')
	}

	await ensureSandboxWritable(sandboxWorkspace)
	await purgeAbandonedFixtures(databaseUrl)
}

/**
 * Delete rows left behind by runs that died.
 *
 * Every spec cleans up in a `finally`, which covers a failing assertion but not a killed
 * process or a timeout that takes the worker with it. The debris accumulates, and
 * because fixture names carry a long `E2E:<spec>:<timestamp>:<rand>` prefix it eventually
 * breaks tests that have nothing to do with it: 78 abandoned automations were enough to
 * push the /automations list past a 412px viewport and fail the mobile overflow check,
 * which reads as a layout regression rather than as leftovers.
 *
 * Only rows whose own name carries the prefix are touched, and only at the start of a
 * run, so this cannot interfere with a spec in flight.
 */
async function purgeAbandonedFixtures(databaseUrl: string) {
	const sql = postgres(databaseUrl, { max: 1 })
	// The column that holds the prefixed name differs per table.
	const tables: Array<[table: string, column: string]> = [
		['automations', 'description'],
		['projects', 'name'],
		['agents', 'name'],
		['repositories', 'owner'],
		['review_items', 'summary'],
		['conversations', 'title'],
		['research', 'query'],
	]
	try {
		let purged = 0
		for (const [table, column] of tables) {
			const deleted = await sql.unsafe(`delete from "${table}" where "${column}" like 'E2E:%' returning 1`)
			purged += deleted.length
		}
		if (purged > 0) console.log(`[global-setup] purged ${purged} abandoned test fixture row(s)`)
	} catch (err) {
		// Never fail a run over cleanup — a missing table on a partially migrated database
		// should not stop the suite that is about to migrate it.
		console.warn('[global-setup] fixture purge skipped:', err instanceof Error ? err.message : err)
	} finally {
		await sql.end({ timeout: 5 })
	}
}
