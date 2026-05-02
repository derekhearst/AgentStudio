#!/usr/bin/env bun
/**
 * Manual workspace GC entry point.
 *
 * Reads SANDBOX_WORKSPACE + DATABASE_URL from the env (or .env), scans the
 * sandbox tree for run-scoped ephemeral workspace dirs whose runs are in a
 * terminal state and finished outside the TTL window, and removes them.
 *
 * Usage:
 *   bun scripts/gc-workspaces.ts                       # delete eligible dirs
 *   bun scripts/gc-workspaces.ts --dry-run             # report only
 *   bun scripts/gc-workspaces.ts --ttl-days 1          # custom TTL
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runWorkspaceGc } from '../src/lib/workspace/gc.server'

function loadDotEnv(): void {
	const path = resolve(process.cwd(), '.env')
	if (!existsSync(path)) return
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eq = trimmed.indexOf('=')
		if (eq < 0) continue
		const key = trimmed.slice(0, eq).trim()
		let value = trimmed.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		if (!process.env[key]) process.env[key] = value
	}
}

function parseArgs(argv: string[]): { dryRun: boolean; ttlDays: number | undefined } {
	let dryRun = false
	let ttlDays: number | undefined
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--dry-run') dryRun = true
		else if (arg === '--ttl-days') {
			const next = argv[++i]
			const parsed = Number.parseInt(next ?? '', 10)
			if (Number.isFinite(parsed) && parsed >= 0) ttlDays = parsed
		}
	}
	return { dryRun, ttlDays }
}

async function main() {
	loadDotEnv()
	const sandboxRoot = process.env.SANDBOX_WORKSPACE
	if (!sandboxRoot) {
		console.error('SANDBOX_WORKSPACE is not set')
		process.exit(1)
	}
	const { dryRun, ttlDays } = parseArgs(process.argv.slice(2))
	console.log(`[gc-workspaces] sandboxRoot=${sandboxRoot} ttlDays=${ttlDays ?? 7} dryRun=${dryRun}`)
	const summary = await runWorkspaceGc({ sandboxRoot, ttlDays, dryRun })
	console.log(JSON.stringify(summary, null, 2))
}

void main().catch((err) => {
	console.error(err)
	process.exit(1)
})
