import { json, type RequestHandler } from '@sveltejs/kit'
import { ownerExists } from '$lib/auth/auth.server'
import { getJobWorkerStatus } from '$lib/db/bootstrap.server'
import { getMigrationStatus } from '$lib/db/migration-status.server'

/**
 * Deploy health check (#47).
 *
 * Exists because a partial deploy is invisible from the outside. On 2026-09-21 three merges
 * raced, the second-newest commit's image won the `:latest` tag, and production ran for
 * twenty minutes without the newest migration — serving 200 on every page the whole time.
 * The only way to catch it was comparing image digests by hand.
 *
 * So this reports the two numbers that would have made it obvious:
 *
 *   bundledMigrations — how many migrations the *running image* ships
 *   appliedMigrations — how many the *database* has applied
 *
 * They match on a healthy deploy. `appliedMigrations < bundledMigrations` means the image
 * shipped a migration that has not run. `appliedMigrations > bundledMigrations` means the
 * image is older than the database — the exact failure this endpoint was written for.
 *
 * It also reports `jobWorker`. A process whose worker failed to start still serves every
 * page, while memory mining, evaluations and automations pile up in `pending`; `failed`
 * marks the deploy degraded so that shows up somewhere. (A failed database bootstrap never
 * reaches this handler at all — `ensureDatabaseReady()` in hooks.server.ts rejects, and
 * every request, this one included, is a 500.)
 *
 * Deliberately unauthenticated (see PUBLIC_PATH_PREFIXES in src/lib/auth/gate.ts) so it can
 * be polled by a uptime check that has no session — including before the instance has an
 * owner, when every other path redirects to /setup. It exposes counts, statuses, a commit
 * SHA and whether an owner exists (which /setup already reveals), never row contents,
 * connection strings, database names or environment values.
 *
 * `ownerProvisioned` is reported but is not part of `healthy`: a fresh instance waiting for
 * setup is up and working, and a deploy probe should not call it an outage.
 */

export const GET: RequestHandler = async () => {
	const { bundledMigrations, appliedMigrations, databaseReachable, migrationsInSync } = await getMigrationStatus()
	const ownerProvisioned = databaseReachable ? await ownerExists().catch(() => false) : false

	// Stamped into the image at build time by the publish workflow.
	const commit = process.env.GIT_SHA ?? null

	const jobWorker = getJobWorkerStatus()

	const healthy = databaseReachable && migrationsInSync && jobWorker !== 'failed'

	return json(
		{
			status: healthy ? 'ok' : 'degraded',
			databaseReachable,
			migrationsInSync,
			bundledMigrations,
			appliedMigrations,
			ownerProvisioned,
			jobWorker,
			commit,
			checkedAt: new Date().toISOString(),
		},
		{
			// 503 on a mismatch so an uptime monitor treats a partial deploy as an outage
			// rather than a healthy page that happens to be missing a table.
			status: healthy ? 200 : 503,
			headers: { 'Cache-Control': 'no-store' },
		},
	)
}
