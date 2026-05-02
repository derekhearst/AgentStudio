import { readdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const DEFAULT_EPHEMERAL_TTL_DAYS = 7

export type RunStatusForGc = {
	id: string
	state: 'queued' | 'running' | 'waiting_tool_approval' | 'waiting_user_input' | 'waiting_plan_decision' | 'completed' | 'failed' | 'canceled'
	finishedAt: Date | null
}

export type LookupRuns = (candidateRunIds: string[]) => Promise<RunStatusForGc[]>

export type GcOptions = {
	sandboxRoot: string
	lookupRuns: LookupRuns
	/** Days an ephemeral workspace must be older than before it becomes eligible for deletion. */
	ttlDays?: number
	/** Don't actually delete — just report what would be deleted. */
	dryRun?: boolean
	/** Now() override for testing. */
	now?: Date
}

export type GcRunSummary = {
	runId: string
	path: string
	deleted: boolean
	skipped: 'pinned' | 'still-active' | 'no-record' | 'too-recent' | null
	error: string | null
}

export type GcSummary = {
	startedAt: string
	finishedAt: string
	scanned: number
	deleted: number
	skipped: number
	errors: number
	dryRun: boolean
	results: GcRunSummary[]
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled'])

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function safeReaddir(path: string): Promise<string[]> {
	try {
		return await readdir(path)
	} catch {
		return []
	}
}

/**
 * Scan the sandbox tree and remove ephemeral run workspaces whose corresponding chat_run is in a
 * terminal state and was finished more than `ttlDays` ago.
 *
 * Workspace layout (per Phase 1 of #7):
 *   <sandboxRoot>/<userId>/runs/<runId>/
 *
 * The legacy `<sandboxRoot>/<userId>/<file>` paths are NEVER touched. Orphan run dirs (no DB row)
 * are skipped so a human can investigate. Active runs are skipped. Recently-finished runs are
 * skipped until TTL elapses.
 *
 * Pure: takes `lookupRuns` so it can be unit-tested without dragging SvelteKit's `$env` import chain.
 */
export async function runWorkspaceGcCore(opts: GcOptions): Promise<GcSummary> {
	const startedAt = new Date()
	const ttlDays = opts.ttlDays ?? DEFAULT_EPHEMERAL_TTL_DAYS
	const now = opts.now ?? startedAt
	const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000)
	const sandboxRoot = resolve(opts.sandboxRoot)
	const dryRun = opts.dryRun ?? false

	const results: GcRunSummary[] = []

	if (!(await exists(sandboxRoot))) {
		return summary(startedAt, results, dryRun)
	}

	// Collect (userId, runId, path) for every run-scoped workspace dir on disk.
	const candidatePaths: Array<{ runId: string; path: string }> = []
	for (const userIdEntry of await safeReaddir(sandboxRoot)) {
		const userRunsDir = resolve(sandboxRoot, userIdEntry, 'runs')
		if (!(await exists(userRunsDir))) continue
		for (const runIdEntry of await safeReaddir(userRunsDir)) {
			candidatePaths.push({ runId: runIdEntry, path: resolve(userRunsDir, runIdEntry) })
		}
	}

	if (candidatePaths.length === 0) {
		return summary(startedAt, results, dryRun)
	}

	const runRows = await opts.lookupRuns(candidatePaths.map((c) => c.runId))
	const byId = new Map(runRows.map((r) => [r.id, r]))

	for (const candidate of candidatePaths) {
		const runRow = byId.get(candidate.runId)
		const item: GcRunSummary = {
			runId: candidate.runId,
			path: candidate.path,
			deleted: false,
			skipped: null,
			error: null,
		}

		if (!runRow) {
			item.skipped = 'no-record'
			results.push(item)
			continue
		}
		if (!TERMINAL_STATES.has(runRow.state)) {
			item.skipped = 'still-active'
			results.push(item)
			continue
		}
		if (!runRow.finishedAt || runRow.finishedAt > cutoff) {
			item.skipped = 'too-recent'
			results.push(item)
			continue
		}

		if (dryRun) {
			results.push(item)
			continue
		}

		try {
			await rm(candidate.path, { recursive: true, force: true })
			item.deleted = true
		} catch (err) {
			item.error = err instanceof Error ? err.message : String(err)
		}
		results.push(item)
	}

	return summary(startedAt, results, dryRun)
}

function summary(startedAt: Date, results: GcRunSummary[], dryRun: boolean): GcSummary {
	let deleted = 0
	let skipped = 0
	let errors = 0
	for (const r of results) {
		if (r.deleted) deleted++
		else if (r.skipped) skipped++
		if (r.error) errors++
	}
	return {
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		scanned: results.length,
		deleted,
		skipped,
		errors,
		dryRun,
		results,
	}
}
