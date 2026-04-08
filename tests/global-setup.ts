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
	await ensureUrlReachable(searxngUrl, 'SEARXNG_URL')
	await ensureSandboxWritable(sandboxWorkspace)
}
