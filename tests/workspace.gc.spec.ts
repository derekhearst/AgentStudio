import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { runWorkspaceGcCore, type LookupRuns, type RunStatusForGc } from '../src/lib/workspace/gc-core'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const TTL_DAYS = 7

/** SQL-backed lookupRuns mirroring gc.server.ts; lets us drive the pure core from tests. */
function makeLookup(): LookupRuns {
	return async (candidateRunIds: string[]) => {
		if (candidateRunIds.length === 0) return []
		const sql = getSql()
		// postgres.js handles array binding for `IN ?` via `${sql(arr)}` — use that.
		const rows = await sql<{ id: string; state: string; finished_at: Date | null }[]>`
			select id, state::text as state, finished_at
			from chat_runs
			where id in ${sql(candidateRunIds)}
		`
		return rows.map((r) => ({
			id: r.id,
			state: r.state as RunStatusForGc['state'],
			finishedAt: r.finished_at,
		}))
	}
}

const lookupRuns = makeLookup()
const runWorkspaceGc = (opts: Parameters<typeof runWorkspaceGcCore>[0] extends infer _ ? Omit<Parameters<typeof runWorkspaceGcCore>[0], 'lookupRuns'> : never) =>
	runWorkspaceGcCore({ ...opts, lookupRuns })

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function exists(p: string) {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

async function makeIsolatedSandbox(prefix: string): Promise<string> {
	const root = resolve(tmpdir(), `agentstudio-gc-${prefix.replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID()}`)
	await mkdir(root, { recursive: true })
	return root
}

async function seedRunDir(sandboxRoot: string, userId: string, runId: string, content = 'hello') {
	const dir = resolve(sandboxRoot, userId, 'runs', runId)
	await mkdir(dir, { recursive: true })
	await writeFile(resolve(dir, 'note.txt'), content)
	return dir
}

async function insertConversationAndRun(opts: {
	prefix: string
	userId: string
	runId: string
	state: 'completed' | 'running' | 'waiting_tool_approval' | 'failed' | 'canceled'
	finishedDaysAgo?: number | null
}) {
	const sql = getSql()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${opts.prefix} convo`}, ${opts.userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const finishedAt = opts.finishedDaysAgo == null ? null : new Date(Date.now() - opts.finishedDaysAgo * 24 * 60 * 60 * 1000)
	await sql`
		insert into chat_runs (id, conversation_id, user_id, state, source, label, finished_at)
		values (
			${opts.runId},
			${conv.id},
			${opts.userId},
			${opts.state}::chat_run_state,
			'chat_stream',
			${`${opts.prefix} run`},
			${finishedAt}
		)
	`
	return conv.id
}

test.describe('workspace/gc — ephemeral run dirs cleaned up after TTL', () => {
	test('deletes a terminal run dir whose finished_at is older than TTL', async () => {
		const prefix = uniquePrefix('ws-gc-old')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const runId = randomUUID()
		const sandboxRoot = await makeIsolatedSandbox(prefix)
		try {
			await insertConversationAndRun({ prefix, userId, runId, state: 'completed', finishedDaysAgo: 14 })
			const dir = await seedRunDir(sandboxRoot, userId, runId, 'old')
			expect(await exists(dir)).toBe(true)

			const summary = await runWorkspaceGc({ sandboxRoot, ttlDays: TTL_DAYS })
			expect(summary.scanned).toBe(1)
			expect(summary.deleted).toBe(1)
			expect(summary.skipped).toBe(0)
			expect(summary.errors).toBe(0)
			expect(await exists(dir)).toBe(false)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('keeps an active run dir even if it has been around for a while', async () => {
		const prefix = uniquePrefix('ws-gc-active')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const runId = randomUUID()
		const sandboxRoot = await makeIsolatedSandbox(prefix)
		try {
			await insertConversationAndRun({ prefix, userId, runId, state: 'running', finishedDaysAgo: null })
			const dir = await seedRunDir(sandboxRoot, userId, runId, 'active')

			const summary = await runWorkspaceGc({ sandboxRoot, ttlDays: 0 })
			expect(summary.scanned).toBe(1)
			expect(summary.deleted).toBe(0)
			expect(summary.skipped).toBe(1)
			expect(summary.results[0].skipped).toBe('still-active')
			expect(await exists(dir)).toBe(true)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('keeps a recently-finished run dir until TTL elapses', async () => {
		const prefix = uniquePrefix('ws-gc-recent')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const runId = randomUUID()
		const sandboxRoot = await makeIsolatedSandbox(prefix)
		try {
			await insertConversationAndRun({ prefix, userId, runId, state: 'completed', finishedDaysAgo: 1 })
			const dir = await seedRunDir(sandboxRoot, userId, runId, 'recent')

			const summary = await runWorkspaceGc({ sandboxRoot, ttlDays: TTL_DAYS })
			expect(summary.deleted).toBe(0)
			expect(summary.skipped).toBe(1)
			expect(summary.results[0].skipped).toBe('too-recent')
			expect(await exists(dir)).toBe(true)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('keeps an orphaned dir whose run row no longer exists', async () => {
		const prefix = uniquePrefix('ws-gc-orphan')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const runId = randomUUID() // no DB row for this runId
		const sandboxRoot = await makeIsolatedSandbox(prefix)
		try {
			const dir = await seedRunDir(sandboxRoot, userId, runId, 'orphan')

			const summary = await runWorkspaceGc({ sandboxRoot })
			expect(summary.deleted).toBe(0)
			expect(summary.skipped).toBe(1)
			expect(summary.results[0].skipped).toBe('no-record')
			expect(await exists(dir), 'orphans are kept for manual inspection').toBe(true)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('legacy <userId>/ paths are never touched', async () => {
		const prefix = uniquePrefix('ws-gc-legacy')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const runId = randomUUID()
		const sandboxRoot = await makeIsolatedSandbox(prefix)
		try {
			// Seed: legacy file at <root>/<userId>/legacy.txt AND a run dir that should be deleted.
			const legacyDir = resolve(sandboxRoot, userId)
			await mkdir(legacyDir, { recursive: true })
			await writeFile(resolve(legacyDir, 'legacy.txt'), 'persistent')
			await insertConversationAndRun({ prefix, userId, runId, state: 'completed', finishedDaysAgo: 30 })
			const runDir = await seedRunDir(sandboxRoot, userId, runId)

			const summary = await runWorkspaceGc({ sandboxRoot, ttlDays: TTL_DAYS })
			expect(summary.deleted).toBe(1)
			expect(await exists(runDir), 'eligible run dir should be deleted').toBe(false)
			expect(await exists(resolve(legacyDir, 'legacy.txt')), 'legacy file must survive').toBe(true)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('dry-run reports without deleting anything', async () => {
		const prefix = uniquePrefix('ws-gc-dryrun')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const runId = randomUUID()
		const sandboxRoot = await makeIsolatedSandbox(prefix)
		try {
			await insertConversationAndRun({ prefix, userId, runId, state: 'completed', finishedDaysAgo: 30 })
			const dir = await seedRunDir(sandboxRoot, userId, runId)

			const summary = await runWorkspaceGc({ sandboxRoot, ttlDays: TTL_DAYS, dryRun: true })
			expect(summary.dryRun).toBe(true)
			expect(summary.scanned).toBe(1)
			expect(summary.deleted).toBe(0)
			expect(await exists(dir), 'dry-run must leave the file in place').toBe(true)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('handles a missing sandbox root without throwing', async () => {
		const summary = await runWorkspaceGc({ sandboxRoot: '/path/that/does/not/exist/agentstudio-gc' })
		expect(summary.scanned).toBe(0)
		expect(summary.deleted).toBe(0)
		expect(summary.errors).toBe(0)
	})
})
