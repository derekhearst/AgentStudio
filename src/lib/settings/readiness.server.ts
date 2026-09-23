import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getMigrationStatus } from '$lib/db/migration-status.server'
import { getSandboxRoot } from '$lib/server/config'
import { bubblewrapAvailable } from '$lib/tools/sandbox-exec.server'
import { buildReadinessRows, type ReadinessRow } from '$lib/settings/readiness'

/**
 * Gathers the facts for the Settings > System checklist (rules in readiness.ts).
 *
 * The Claude check looks for a credential rather than proving one works: an environment key,
 * or the Claude Code CLI's login file. Proving it would mean spawning the CLI (and on some
 * accounts spending a request) every time the page opens; a stale login still shows up at
 * the first chat, with the SDK's own error. On macOS the CLI keeps its login in the
 * keychain, which this cannot see — the server targets Linux containers.
 */
export async function getSystemReadiness(): Promise<ReadinessRow[]> {
	const [migrations, claudeCredentialFile, sandbox] = await Promise.all([
		getMigrationStatus(),
		findClaudeCredentialFile(),
		checkSandbox(),
	])
	return buildReadinessRows({
		env: process.env,
		migrations: {
			databaseReachable: migrations.databaseReachable,
			migrationsInSync: migrations.migrationsInSync,
			bundled: migrations.bundledMigrations,
			applied: migrations.appliedMigrations,
		},
		claudeCredentialFile,
		sandbox,
		shellSandbox: process.env.SANDBOX_DISABLED === '1' ? false : bubblewrapAvailable(),
	})
}

async function findClaudeCredentialFile(): Promise<string | null> {
	const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
	const file = join(configDir, '.credentials.json')
	try {
		await access(file, constants.R_OK)
		return file
	} catch {
		return null
	}
}

async function checkSandbox(): Promise<{ root: string; writable: boolean }> {
	const root = getSandboxRoot()
	try {
		await access(root, constants.R_OK | constants.W_OK)
		return { root, writable: true }
	} catch {
		return { root, writable: false }
	}
}
