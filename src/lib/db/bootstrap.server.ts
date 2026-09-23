/**
 * Database bootstrap pipeline — extracted from `db.server.ts` so the runtime client
 * module stays a thin export of the connection + drizzle handle.
 *
 * `bootstrapDatabase()` runs at module load (kicked off by `db.server.ts`) and:
 *
 *   1. Creates the database if it doesn't exist.
 *   2. Takes the bootstrap advisory lock, so concurrent processes migrate one at a time.
 *   3. Reconciles legacy schema state — refusing, with instructions, to touch anything
 *      it cannot positively identify as AgentStudio's (see `planLegacySchemaReconcile`).
 *   4. Installs required Postgres extensions (pgvector, etc).
 *   5. Runs Drizzle migrations against the latest local revision. A failure is reported
 *      with instructions; it never triggers a reset.
 *   6. Seeds the built-in agents, the default evaluator, and any AGENTS.md /
 *      SKILL.md repo-discovered rows.
 *   7. Registers job handlers (research, memory mining, evaluations, workspace gc,
 *      automations, metrics sampler, runs reaper, logs retention).
 *   8. Starts the in-process worker + scheduler unless JOBS_WORKER_ENABLED=0.
 *   9. Kicks off the skill-embedding backfill in the background.
 *
 * Steps 1–5 retry while Postgres is unreachable and otherwise throw: a database that
 * could not be prepared is reported by `ensureDatabaseReady()` rejecting (see
 * `readiness.server.ts`), not logged and forgotten. Steps 6–9 are fail-isolated: a
 * single broken seeder or handler-registration call logs a warning and continues.
 *
 * `console.*` is used here intentionally — the `app_logs` table doesn't exist
 * until step 5 finishes, so the logger's DB sink would have nothing to write to
 * during the early phases. Operators reading container output need these lines.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import {
	LEGACY_SCHEMA_RESET_FLAG,
	MIGRATIONS_SCHEMA,
	MIGRATIONS_TABLE,
	describeMigrationFailure,
	ensureDatabaseExists,
	ensureRequiredExtensions,
	getKnownAppObjects,
	getLastAppliedMigrationMillis,
	getLatestLocalMigrationMillis,
	getMigrationsFolder,
	getTargetDatabaseName,
	reconcileLegacySchemaState,
	withBootstrapLock,
} from '$lib/db/migrations.server'
import { retryOnTransientConnectionError } from '$lib/db/readiness.server'
import { schema } from '$lib/db/schema.server'
import type postgres from 'postgres'

type Client = ReturnType<typeof postgres>

// Build a typed drizzle handle. We let TypeScript infer the full return type so the
// `$client` property + the schema-derived table fields all match what the domain
// seed functions expect (they take `ReturnType<typeof createDatabase>` from
// `db.server.ts`, which is structurally identical).
const createSchemaDb = (client: Client) => drizzle(client, { schema })

export type BootstrapInput = {
	client: Client
	databaseUrl: string
	/** Backoff between connection retries; defaults to BOOTSTRAP_RETRY_DELAYS_MS. */
	retryDelaysMs?: readonly number[]
}

export async function bootstrapDatabase(input: BootstrapInput): Promise<void> {
	const { client, databaseUrl } = input
	let databaseName = '(unnamed)'

	try {
		databaseName = getTargetDatabaseName(databaseUrl)
		await retryOnTransientConnectionError(() => prepareSchema(client, databaseUrl, databaseName), {
			delaysMs: input.retryDelaysMs,
			onRetry: (err, attempt, delayMs) => {
				const detail = err instanceof Error ? err.message : String(err)
				console.warn(
					`[db] Database "${databaseName}" not reachable yet (${detail}); retry ${attempt} in ${delayMs / 1000}s`,
				)
			},
		})
	} catch (err) {
		console.error(`[db] Bootstrap of "${databaseName}" failed; requests will fail until it is fixed:`, err)
		throw err
	}

	await startServices(client)
}

/**
 * Steps 1–5: make the schema match the bundled migrations, or throw. Runs again in full on
 * a retry, which is safe: every step is idempotent and the migrations are transactional.
 */
async function prepareSchema(client: Client, databaseUrl: string, databaseName: string): Promise<void> {
	const createdDatabase = await ensureDatabaseExists(databaseUrl)

	await withBootstrapLock(databaseUrl, async () => {
		const resetLegacySchema = await reconcileLegacySchemaState(client, {
			databaseName,
			getKnownObjects: () => getKnownAppObjects(schema),
			allowReset: process.env[LEGACY_SCHEMA_RESET_FLAG] === '1',
		})
		await ensureRequiredExtensions(client)

		const latestLocalMigrationMillis = getLatestLocalMigrationMillis()
		const lastAppliedMigrationMillis = await getLastAppliedMigrationMillis(client)
		const hasPendingMigrations =
			latestLocalMigrationMillis !== null &&
			(lastAppliedMigrationMillis === null ||
				lastAppliedMigrationMillis < latestLocalMigrationMillis)

		if (createdDatabase || resetLegacySchema || hasPendingMigrations) {
			console.log('[db] Applying migrations')
		}

		const migrationConfig = {
			migrationsFolder: getMigrationsFolder(),
			migrationsSchema: MIGRATIONS_SCHEMA,
			migrationsTable: MIGRATIONS_TABLE,
		}

		try {
			await migrate(createSchemaDb(client), migrationConfig)
		} catch (migrationError) {
			// Never "recover" by dropping the schemas. That used to happen on any process
			// without NODE_ENV=production, and a drift error replays identically after a
			// reset, so it bought an empty database and the same failure.
			throw new Error(describeMigrationFailure(migrationError, databaseName), { cause: migrationError })
		}

		if (createdDatabase || resetLegacySchema || hasPendingMigrations) {
			console.log(`[db] Database bootstrapped and ready (${databaseName})`)
		} else {
			console.log(`[db] Database ready (${databaseName})`)
		}
	})
}

// Steps 6–9 run once per process, however many times the schema steps are attempted.
let servicesStarted = false

async function startServices(client: Client): Promise<void> {
	if (servicesStarted) return
	servicesStarted = true

	await runSeeders(client)
	await registerJobHandlers()
	startWorkerAndScheduler()
	kickoffBackgroundBackfills()
}

/**
 * Built-in row seeders. Each is idempotent and runs ON CONFLICT (id) DO NOTHING so
 * operator edits to seeded rows survive re-runs. Failures are best-effort —
 * a missing built-in agent would just mean the orchestrator falls back to its
 * default identity until the next boot.
 */
async function runSeeders(client: Client): Promise<void> {
	try {
		const { seedBuiltinAgents } = await import('$lib/agents/builtin-agents.server')
		const seedDb = createSchemaDb(client)
		const result = await seedBuiltinAgents(seedDb)
		if (result.agentsUpserted > 0) {
			console.log(`[db] Seeded ${result.agentsUpserted} built-in agent(s)`)
		}
	} catch (err) {
		console.warn('[db] Built-in agents seed failed (non-fatal):', err)
	}

	try {
		const { registerBuiltinHooks } = await import('$lib/hooks')
		registerBuiltinHooks()
	} catch (err) {
		console.warn('[db] Hook registration failed (non-fatal):', err)
	}

	try {
		const { seedDefaultEvaluator } = await import('$lib/evaluations/evaluators-seed.server')
		const seedDb = createSchemaDb(client)
		const result = await seedDefaultEvaluator(seedDb)
		if (result.inserted > 0) {
			console.log('[db] Seeded default evaluator agent')
		}
	} catch (err) {
		console.warn('[db] Default evaluator seed failed (non-fatal):', err)
	}

	try {
		const { loadAgentSourcesAtBoot } = await import('$lib/agents/agent-source-loader.server')
		const seedDb = createSchemaDb(client)
		const result = await loadAgentSourcesAtBoot(seedDb)
		if (result) {
			const summary = [
				result.agentsInserted > 0 ? `${result.agentsInserted} inserted` : null,
				result.agentsUpdated > 0 ? `${result.agentsUpdated} updated` : null,
				result.agentsSkipped > 0 ? `${result.agentsSkipped} skipped` : null,
			]
				.filter(Boolean)
				.join(', ')
			if (summary) {
				console.log(`[db] AGENTS.md scan: ${summary}`)
			}
			for (const err of result.errors) {
				console.warn(`[db] AGENTS.md scan: ${err}`)
			}
		}
	} catch (err) {
		console.warn('[db] AGENTS.md scan failed (non-fatal):', err)
	}

	try {
		const { loadSkillSourcesAtBoot } = await import('$lib/skills/skill-source-loader.server')
		const seedDb = createSchemaDb(client)
		const result = await loadSkillSourcesAtBoot(seedDb)
		if (result) {
			const summary = [
				result.inserted > 0 ? `${result.inserted} inserted` : null,
				result.updated > 0 ? `${result.updated} updated` : null,
				result.skipped > 0 ? `${result.skipped} skipped` : null,
			]
				.filter(Boolean)
				.join(', ')
			if (summary) {
				console.log(`[db] SKILL.md scan: ${summary}`)
			}
			for (const err of result.errors) {
				console.warn(`[db] SKILL.md scan: ${err}`)
			}
		}
	} catch (err) {
		console.warn('[db] SKILL.md scan failed (non-fatal):', err)
	}
}

/**
 * Register every domain's job handlers BEFORE the worker starts. A claimed job
 * with no registered handler would land in a permanent failure loop, so order
 * matters: handler registration completes before `startJobWorker()` is called.
 */
async function registerJobHandlers(): Promise<void> {
	try {
		const { registerResearchJobHandlers } = await import('$lib/research/research-handler.server')
		registerResearchJobHandlers()
	} catch (err) {
		console.warn('[db] Research handler registration failed (non-fatal):', err)
	}

	try {
		const { registerMemoryJobHandlers } = await import('$lib/memory/memory-handler.server')
		registerMemoryJobHandlers()
	} catch (err) {
		console.warn('[db] Memory handler registration failed (non-fatal):', err)
	}

	try {
		const { registerEvaluationJobHandlers } = await import(
			'$lib/evaluations/evaluations-handler.server'
		)
		registerEvaluationJobHandlers()
	} catch (err) {
		console.warn('[db] Evaluation handler registration failed (non-fatal):', err)
	}

	try {
		const { registerWorkspaceJobHandlers } = await import(
			'$lib/workspace/workspace-handler.server'
		)
		registerWorkspaceJobHandlers()
	} catch (err) {
		console.warn('[db] Workspace handler registration failed (non-fatal):', err)
	}

	try {
		const { registerAutomationJobHandlers } = await import(
			'$lib/automations/automation-handler.server'
		)
		registerAutomationJobHandlers()
	} catch (err) {
		console.warn('[db] Automation handler registration failed (non-fatal):', err)
	}

	try {
		const { registerMonitorJobHandlers } = await import('$lib/monitors/monitors-handler.server')
		registerMonitorJobHandlers()
	} catch (err) {
		console.warn('[db] Monitor handler registration failed (non-fatal):', err)
	}

	try {
		const { registerPullRequestWatchJobHandlers } = await import(
			'$lib/source-control/pr-watch-handler.server'
		)
		registerPullRequestWatchJobHandlers()
	} catch (err) {
		console.warn('[db] PR watch handler registration failed (non-fatal):', err)
	}

	try {
		const { registerMetricsJobHandlers } = await import(
			'$lib/observability/metrics-handler.server'
		)
		registerMetricsJobHandlers()
	} catch (err) {
		console.warn('[db] Metrics handler registration failed (non-fatal):', err)
	}

	try {
		const { registerRunsJobHandlers } = await import('$lib/runs/runs-handler.server')
		registerRunsJobHandlers()
	} catch (err) {
		console.warn('[db] Runs handler registration failed (non-fatal):', err)
	}

	try {
		const { registerLogsJobHandlers } = await import('$lib/observability/logs-handler.server')
		registerLogsJobHandlers()
	} catch (err) {
		console.warn('[db] Logs handler registration failed (non-fatal):', err)
	}
}

/**
 * Whether this process's job worker is running, for `/api/health`. `pending` covers the
 * moment between bootstrap finishing and the worker module loading; `disabled` means
 * JOBS_WORKER_ENABLED=0 (a one-shot script, or a web tier paired with worker containers).
 */
export type JobWorkerStatus = 'pending' | 'disabled' | 'running' | 'failed'

let jobWorkerStatus: JobWorkerStatus = 'pending'

export function getJobWorkerStatus(): JobWorkerStatus {
	return jobWorkerStatus
}

/**
 * Start the in-process worker + scheduler. Both opt-out via env vars
 * (JOBS_WORKER_ENABLED=0, JOBS_SCHEDULER_ENABLED=0) so a one-shot migration
 * script doesn't accidentally claim jobs.
 */
function startWorkerAndScheduler(): void {
	if (process.env.JOBS_WORKER_ENABLED === '0') {
		jobWorkerStatus = 'disabled'
		return
	}

	void (async () => {
		try {
			const { startJobWorker } = await import('$lib/jobs/worker.server')
			const worker = startJobWorker({ pollIntervalMs: 2000, leaseTtlMs: 120_000 })
			jobWorkerStatus = 'running'
			console.log(`[db] Started in-process job worker (id=${worker.workerId})`)
		} catch (err) {
			jobWorkerStatus = 'failed'
			console.error('[db] Job worker start failed; queued jobs will not run in this process:', err)
		}
	})()

	if (process.env.JOBS_SCHEDULER_ENABLED === '0') return

	void (async () => {
		try {
			const { startScheduler, listScheduledJobs } = await import('$lib/jobs/scheduler.server')
			startScheduler()
			const scheduled = listScheduledJobs()
			if (scheduled.length > 0) {
				console.log(
					`[db] Started job scheduler with ${scheduled.length} recurring job(s): ${scheduled.map((s) => s.name).join(', ')}`,
				)
			}
		} catch (err) {
			console.warn('[db] Scheduler start failed (non-fatal):', err)
		}
	})()
}

/**
 * Skill-embedding backfill — best-effort, runs once at boot. Non-blocking; the
 * logger's relevance filter falls back to listing every skill if embeddings
 * aren't ready yet.
 */
function kickoffBackgroundBackfills(): void {
	void (async () => {
		try {
			const { backfillSkillEmbeddings } = await import('$lib/skills/skills.server')
			const result = await backfillSkillEmbeddings(50)
			if (result.embedded > 0) {
				console.log(`[db] Backfilled ${result.embedded} skill embedding(s)`)
			}
		} catch (err) {
			console.warn('[db] Skill embedding backfill failed (non-fatal):', err)
		}
	})()
}
