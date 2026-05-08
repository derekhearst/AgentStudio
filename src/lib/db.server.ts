import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import {
	MIGRATIONS_SCHEMA,
	MIGRATIONS_TABLE,
	ensureDatabaseExists,
	ensureRequiredExtensions,
	getLastAppliedMigrationMillis,
	getLatestLocalMigrationMillis,
	getMigrationsFolder,
	handleDatabaseNotice,
	isRecoverableMigrationError,
	reconcileLegacySchemaState,
	resetAppSchemas,
} from '$lib/db/migrations.server'

// Load .env into process.env so server modules can read directly without depending on
// SvelteKit's `$env/dynamic/private` virtual module. Bun auto-loads .env when invoking
// scripts but Vite's SSR module runner doesn't inherit that into the same evaluation
// context (we saw DATABASE_URL come back undefined during `vite dev` spawn). Explicit
// load is idempotent — already-set vars are preserved.
loadDotEnv()
function loadDotEnv() {
	try {
		const envPath = resolve(process.cwd(), '.env')
		if (!existsSync(envPath)) return
		const raw = readFileSync(envPath, 'utf8')
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
			if (process.env[key] === undefined) {
				process.env[key] = value
			}
		}
	} catch {
		// non-fatal — env-dependent code paths will throw with their own clearer messages
	}
}
import * as authSchema from '$lib/auth/auth.schema'
import * as sessionsSchema from '$lib/sessions/sessions.schema'
import * as agentsSchema from '$lib/agents/agents.schema'
import * as notificationsSchema from '$lib/notifications/notifications.schema'
import * as settingsSchema from '$lib/settings/settings.schema'
import * as activitySchema from '$lib/activity/activity.schema'
import * as llmUsageSchema from '$lib/costs/usage.schema'
import * as skillsSchema from '$lib/skills/skills.schema'
import * as automationSchema from '$lib/automations/automation.schema'
import * as runsSchema from '$lib/runs/runs.schema'
import * as memorySchema from '$lib/memory/memory.schema'
import * as chatWorkbenchSchema from '$lib/chat/chat.workbench.schema'
import * as contextSchema from '$lib/context/context.schema'
import * as governanceSchema from '$lib/governance/governance.schema'
import * as hooksSchema from '$lib/hooks/hooks.schema'
import * as evaluationsSchema from '$lib/evaluations/evaluations.schema'
import * as projectsSchema from '$lib/projects/projects.schema'
import * as jobsSchema from '$lib/jobs/jobs.schema'
import * as researchSchema from '$lib/research/research.schema'
import * as imagesSchema from '$lib/images/images.schema'
import * as observabilitySchema from '$lib/observability/observability.schema'
import * as sourceControlSchema from '$lib/source-control/source-control.schema'

// Bootstrap detection without `$app/environment` so the module is importable from
// non-SvelteKit contexts (Playwright Node runtime, scripts, …). The `BUILD_PHASE` env
// var is set by `package.json`'s `build` script; missing/unset means runtime.
const databaseUrl = process.env.DATABASE_URL
const skipDatabaseInitialization = process.env.BUILD_PHASE === '1'

const schema = {
	...authSchema,
	...sessionsSchema,
	...agentsSchema,
	...notificationsSchema,
	...settingsSchema,
	...activitySchema,
	...llmUsageSchema,
	...skillsSchema,
	...memorySchema,
	...automationSchema,
	...runsSchema,
	...chatWorkbenchSchema,
	...contextSchema,
	...governanceSchema,
	...hooksSchema,
	...evaluationsSchema,
	...projectsSchema,
	...jobsSchema,
	...researchSchema,
	...imagesSchema,
	...observabilitySchema,
	...sourceControlSchema,
}

function createDatabaseClient(url: string) {
	return postgres(url, {
		onnotice: handleDatabaseNotice,
	})
}

function createDatabase(connection: ReturnType<typeof createDatabaseClient>) {
	return drizzle(connection, { schema })
}

type Database = ReturnType<typeof createDatabase>

function createUnavailableDatabase(): Database {
	return new Proxy(
		{},
		{
			get() {
				throw new Error('Database is unavailable during build because DATABASE_URL is not set')
			},
		},
	) as Database
}

if (!databaseUrl && !skipDatabaseInitialization) {
	throw new Error('DATABASE_URL is not set')
}

const client = skipDatabaseInitialization ? null : createDatabaseClient(databaseUrl!)

async function bootstrapDatabase() {
	if (!client || !databaseUrl) {
		return
	}

	try {
		const createdDatabase = await ensureDatabaseExists(databaseUrl)
		const resetLegacySchema = await reconcileLegacySchemaState(client)
		await ensureRequiredExtensions(client)

		const latestLocalMigrationMillis = getLatestLocalMigrationMillis()
		const lastAppliedMigrationMillis = await getLastAppliedMigrationMillis(client)
		const hasPendingMigrations =
			latestLocalMigrationMillis !== null &&
			(lastAppliedMigrationMillis === null || lastAppliedMigrationMillis < latestLocalMigrationMillis)

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
			const bootstrapDb = createDatabase(client)
			await migrate(bootstrapDb, migrationConfig)
		} catch (migrationError) {
			const shouldAttemptRecovery = process.env.NODE_ENV !== 'production' && isRecoverableMigrationError(migrationError)

			if (!shouldAttemptRecovery) {
				throw migrationError
			}

			recoveredFromDrift = true
			console.warn(
				'[db] Migration drift detected; resetting app schemas and retrying migrations once (development only)',
			)
			await resetAppSchemas(client)
			await ensureRequiredExtensions(client)

			const retryDb = createDatabase(client)
			await migrate(retryDb, migrationConfig)
		}

		if (createdDatabase || resetLegacySchema || hasPendingMigrations || recoveredFromDrift) {
			console.log('[db] Database bootstrapped and ready')
		} else {
			console.log('[db] Database ready')
		}

		// Seed built-in agents (chat / research / plan / autonomous). Idempotent upsert by id.
		// Lazy-imported to avoid a require cycle and pass a fresh db handle, since the top-level
		// `db` export of this file is evaluated AFTER `await databaseReadyPromise`.
		try {
			const { seedBuiltinAgents } = await import('$lib/agents/builtin-agents.server')
			const seedDb = createDatabase(client)
			const result = await seedBuiltinAgents(seedDb)
			if (result.agentsUpserted > 0) {
				console.log(`[db] Seeded ${result.agentsUpserted} built-in agent(s)`)
			}
		} catch (err) {
			console.warn('[db] Built-in agents seed failed (non-fatal):', err)
		}

		// Wave 3 #13 phase 1 — register the built-in hook handlers exactly once at boot.
		try {
			const { registerBuiltinHooks } = await import('$lib/hooks')
			registerBuiltinHooks()
		} catch (err) {
			console.warn('[db] Hook registration failed (non-fatal):', err)
		}

		// Wave 3 #14 evaluations plan phase 1 — seed the default evaluator agent. Idempotent;
		// user edits to the prompt/model survive re-seed via ON CONFLICT (id) DO NOTHING.
		try {
			const { seedDefaultEvaluator } = await import('$lib/evaluations/evaluators-seed.server')
			const seedDb = createDatabase(client)
			const result = await seedDefaultEvaluator(seedDb)
			if (result.inserted > 0) {
				console.log('[db] Seeded default evaluator agent')
			}
		} catch (err) {
			console.warn('[db] Default evaluator seed failed (non-fatal):', err)
		}

		// AGENTS.md repo-file discovery. Scans `docs/agents/<slug>/AGENT.md` files and upserts
		// each into the `agents` table. No-op if no such files exist at the configured root,
		// so the default deployment stays quiet for operators who don't use this feature.
		try {
			const { loadAgentSourcesAtBoot } = await import('$lib/agents/agent-source-loader.server')
			const seedDb = createDatabase(client)
			const result = await loadAgentSourcesAtBoot(seedDb)
			if (result) {
				const summary = [
					result.agentsInserted > 0 ? `${result.agentsInserted} inserted` : null,
					result.agentsUpdated > 0 ? `${result.agentsUpdated} updated` : null,
					result.agentsSkipped > 0 ? `${result.agentsSkipped} skipped` : null,
				].filter(Boolean).join(', ')
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

		// PR-4 — SKILL.md repo-file discovery. Mirror of the AGENTS.md scanner: scans
		// `${SKILL_SOURCE_PATH}/skills/<slug>/SKILL.md` and upserts. Default priority is `db`
		// (repo only inserts new), so the loader is silent on installs that don't use it.
		try {
			const { loadSkillSourcesAtBoot } = await import('$lib/skills/skill-source-loader.server')
			const seedDb = createDatabase(client)
			const result = await loadSkillSourcesAtBoot(seedDb)
			if (result) {
				const summary = [
					result.inserted > 0 ? `${result.inserted} inserted` : null,
					result.updated > 0 ? `${result.updated} updated` : null,
					result.skipped > 0 ? `${result.skipped} skipped` : null,
				].filter(Boolean).join(', ')
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

		// Wave 4 #18 phase 3 — register the `research_run` job handler. Must happen BEFORE the
		// worker starts so claimed research jobs find a handler.
		try {
			const { registerResearchJobHandlers } = await import('$lib/research/research-handler.server')
			registerResearchJobHandlers()
		} catch (err) {
			console.warn('[db] Research handler registration failed (non-fatal):', err)
		}

		// Wave 4 #17 phase 5 partial — register the `memory_mine` job handler. Replaces the
		// previously inline fire-and-forget mining call in the chat-stream handler.
		try {
			const { registerMemoryJobHandlers } = await import('$lib/memory/memory-handler.server')
			registerMemoryJobHandlers()
		} catch (err) {
			console.warn('[db] Memory handler registration failed (non-fatal):', err)
		}

		// Wave 4 #17 phase 5 — register the `evaluation_run` job handler. Replaces the previously
		// inline fire-and-forget evaluator-pass call in the chat-stream handler.
		try {
			const { registerEvaluationJobHandlers } = await import('$lib/evaluations/evaluations-handler.server')
			registerEvaluationJobHandlers()
		} catch (err) {
			console.warn('[db] Evaluation handler registration failed (non-fatal):', err)
		}

		// Wave 4 #17 phase 4 + 5 — register the `workspace_gc` job handler + its daily schedule.
		try {
			const { registerWorkspaceJobHandlers } = await import('$lib/workspace/workspace-handler.server')
			registerWorkspaceJobHandlers()
		} catch (err) {
			console.warn('[db] Workspace handler registration failed (non-fatal):', err)
		}

		// Wave 4 #17 phase 5 finish — register the `automation_run` + `automations_dispatch`
		// job handlers + the per-minute dispatch tick.
		try {
			const { registerAutomationJobHandlers } = await import('$lib/automations/automation-handler.server')
			registerAutomationJobHandlers()
		} catch (err) {
			console.warn('[db] Automation handler registration failed (non-fatal):', err)
		}

		// Wave 5 #20 phase 4 — register the `metrics_sample` job handler + 5min sampler tick.
		try {
			const { registerMetricsJobHandlers } = await import('$lib/observability/metrics-handler.server')
			registerMetricsJobHandlers()
		} catch (err) {
			console.warn('[db] Metrics handler registration failed (non-fatal):', err)
		}

		// Stuck-run reaper — sweeps chat_runs stuck in active states with no `updatedAt`
		// movement for >1h (runtime crashed/restarted, leaving "Waiting for you" rows alive).
		try {
			const { registerRunsJobHandlers } = await import('$lib/runs/runs-handler.server')
			registerRunsJobHandlers()
		} catch (err) {
			console.warn('[db] Runs handler registration failed (non-fatal):', err)
		}

		// App-log retention + DB sink enable — must come after migrations so app_logs exists
		// before the logger's first flush.
		try {
			const { registerLogsJobHandlers } = await import('$lib/observability/logs-handler.server')
			registerLogsJobHandlers()
		} catch (err) {
			console.warn('[db] Logs handler registration failed (non-fatal):', err)
		}

		// Wave 4 #17 phase 1 — start the in-process job worker. Opt-out via JOBS_WORKER_ENABLED=0
		// for cases like running migrations + seed in a one-shot script. Default-on so dev sessions
		// pick up jobs immediately. A future deployment can run a separate worker process with the
		// web tier's worker disabled.
		if (process.env.JOBS_WORKER_ENABLED !== '0') {
			try {
				const { startJobWorker } = await import('$lib/jobs/worker.server')
				const worker = startJobWorker({ pollIntervalMs: 2000, leaseTtlMs: 120_000 })
				console.log(`[db] Started in-process job worker (id=${worker.workerId})`)
			} catch (err) {
				console.warn('[db] Job worker start failed (non-fatal):', err)
			}
		}

		// Wave 4 #17 phase 4 — start the scheduler AFTER handler registration so the first tick
		// always finds a registered handler. Opt-out via JOBS_SCHEDULER_ENABLED=0.
		if (process.env.JOBS_WORKER_ENABLED !== '0' && process.env.JOBS_SCHEDULER_ENABLED !== '0') {
			try {
				const { startScheduler, listScheduledJobs } = await import('$lib/jobs/scheduler.server')
				startScheduler()
				const scheduled = listScheduledJobs()
				if (scheduled.length > 0) {
					console.log(`[db] Started job scheduler with ${scheduled.length} recurring job(s): ${scheduled.map((s) => s.name).join(', ')}`)
				}
			} catch (err) {
				console.warn('[db] Scheduler start failed (non-fatal):', err)
			}
		}

		// Phase 4 of #4: backfill embeddings for any skills that don't have them yet, so the
		// relevance filter has something to rank. Best-effort; failures are non-fatal (the
		// fallback path lists every skill exactly like before).
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
	} catch (err) {
		console.error('[db] Bootstrap failed — database may be unavailable:', err)
	}
}

const databaseReadyPromise = skipDatabaseInitialization ? Promise.resolve() : bootstrapDatabase()

export async function ensureDatabaseReady() {
	await databaseReadyPromise
}

// Top-level await intentionally removed: it caused a circular ESM-await deadlock when
// bootstrap's own dynamic seeders (which transitively import db.server) waited on this
// module's load to complete. All real callers (hooks.server.ts, every remote function
// handler) already call `ensureDatabaseReady()` at the request boundary, so the promise
// is awaited at the right time without blocking the module graph.

export const db: Database = client ? createDatabase(client) : createUnavailableDatabase()
