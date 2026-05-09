/**
 * Database bootstrap pipeline — extracted from `db.server.ts` so the runtime client
 * module stays a thin export of the connection + drizzle handle.
 *
 * `bootstrapDatabase()` runs at module load (kicked off by `db.server.ts`) and:
 *
 *   1. Creates the database if it doesn't exist; reconciles legacy schema state.
 *   2. Installs required Postgres extensions (pgvector, etc).
 *   3. Runs Drizzle migrations against the latest local revision. On dev, recovers
 *      from drift by resetting app schemas + retrying once.
 *   4. Seeds the built-in agents, the default evaluator, and any AGENTS.md /
 *      SKILL.md repo-discovered rows.
 *   5. Registers job handlers (research, memory mining, evaluations, workspace gc,
 *      automations, metrics sampler, runs reaper, logs retention).
 *   6. Starts the in-process worker + scheduler unless JOBS_WORKER_ENABLED=0.
 *   7. Kicks off the skill-embedding backfill in the background.
 *
 * Each step is fail-isolated: a single broken seeder or handler-registration call
 * logs a warning and continues. The whole pipeline is wrapped in try/catch so a
 * total failure leaves the DB unusable but doesn't crash the process.
 *
 * `console.*` is used here intentionally — the `app_logs` table doesn't exist
 * until step 3 finishes, so the logger's DB sink would have nothing to write to
 * during the early phases. Operators reading container output need these lines.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import {
	MIGRATIONS_SCHEMA,
	MIGRATIONS_TABLE,
	ensureDatabaseExists,
	ensureRequiredExtensions,
	getLastAppliedMigrationMillis,
	getLatestLocalMigrationMillis,
	getMigrationsFolder,
	isRecoverableMigrationError,
	reconcileLegacySchemaState,
	resetAppSchemas,
} from '$lib/db/migrations.server'
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
}

export async function bootstrapDatabase(input: BootstrapInput): Promise<void> {
	const { client, databaseUrl } = input

	try {
		const createdDatabase = await ensureDatabaseExists(databaseUrl)
		const resetLegacySchema = await reconcileLegacySchemaState(client)
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

		let recoveredFromDrift = false

		try {
			const bootstrapDb = createSchemaDb(client)
			await migrate(bootstrapDb, migrationConfig)
		} catch (migrationError) {
			const shouldAttemptRecovery =
				process.env.NODE_ENV !== 'production' && isRecoverableMigrationError(migrationError)

			if (!shouldAttemptRecovery) {
				throw migrationError
			}

			recoveredFromDrift = true
			console.warn(
				'[db] Migration drift detected; resetting app schemas and retrying migrations once (development only)',
			)
			await resetAppSchemas(client)
			await ensureRequiredExtensions(client)

			const retryDb = createSchemaDb(client)
			await migrate(retryDb, migrationConfig)
		}

		if (createdDatabase || resetLegacySchema || hasPendingMigrations || recoveredFromDrift) {
			console.log('[db] Database bootstrapped and ready')
		} else {
			console.log('[db] Database ready')
		}

		await runSeeders(client)
		await registerJobHandlers()
		startWorkerAndScheduler()
		kickoffBackgroundBackfills()
	} catch (err) {
		console.error('[db] Bootstrap failed — database may be unavailable:', err)
	}
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
 * Start the in-process worker + scheduler. Both opt-out via env vars
 * (JOBS_WORKER_ENABLED=0, JOBS_SCHEDULER_ENABLED=0) so a one-shot migration
 * script doesn't accidentally claim jobs.
 */
function startWorkerAndScheduler(): void {
	if (process.env.JOBS_WORKER_ENABLED === '0') return

	void (async () => {
		try {
			const { startJobWorker } = await import('$lib/jobs/worker.server')
			const worker = startJobWorker({ pollIntervalMs: 2000, leaseTtlMs: 120_000 })
			console.log(`[db] Started in-process job worker (id=${worker.workerId})`)
		} catch (err) {
			console.warn('[db] Job worker start failed (non-fatal):', err)
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
