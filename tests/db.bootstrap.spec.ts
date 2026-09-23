import { expect, test } from '@playwright/test'
import {
	BOOTSTRAP_LOCK_KEY,
	CORE_APP_TABLES,
	getKnownAppObjects,
	listUnmanagedSchemaObjects,
	planLegacySchemaReconcile,
	reconcileLegacySchemaState,
	withBootstrapLock,
} from '../src/lib/db/migrations.server'
import { schema } from '../src/lib/db/schema.server'
import { getSql, readEnvVar } from './helpers'
import { TEST_SERVER_HEALTH_URL } from './server-env'

/**
 * Database bootstrap against the real test database. Read-only apart from advisory locks:
 * nothing here creates, drops or alters a schema object, and the lock specs use their own
 * key so they never hold up a real boot.
 *
 * The pure decisions are pinned in `db.bootstrap-safety.unit.spec.ts`; this file proves
 * the SQL behind them works on a real Postgres.
 */

/**
 * A fresh key per test: distinct from BOOTSTRAP_LOCK_KEY, above the 32-bit range the
 * helpers hash into, and different between the desktop and mobile runs of the same test,
 * which would otherwise contend for one lock and reorder each other's events.
 */
function testLockKey() {
	return BOOTSTRAP_LOCK_KEY + 1 + Math.floor(Math.random() * 1_000_000)
}

function databaseUrl() {
	const url = readEnvVar('DATABASE_URL')
	if (!url) throw new Error('DATABASE_URL must be set')
	return url
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Hold the lock with `fn`, and resolve `locked` once `fn` has started, i.e. once the lock
 * is really held. The lock client connects lazily on its first query, so a fixed head
 * start could lose to a slow connect (eight workers connecting at once, or the LAN
 * database) and let the "second" caller take the lock first.
 */
function holdLock(key: number, fn: () => Promise<void>) {
	let signalLocked!: () => void
	const locked = new Promise<void>((resolve) => {
		signalLocked = resolve
	})
	const done = withBootstrapLock(
		databaseUrl(),
		async () => {
			signalLocked()
			await fn()
		},
		{ key, pollIntervalMs: 50 },
	)
	// Racing `done` surfaces a failure to take the lock instead of waiting forever on `locked`.
	return { locked: Promise.race([locked, done]), done }
}

test.describe('db/bootstrap — migration lock', () => {
	test('a second bootstrap waits for the first to finish instead of migrating alongside it', async () => {
		const key = testLockKey()
		const events: string[] = []

		const first = holdLock(key, async () => {
			events.push('first:start')
			await sleep(500)
			events.push('first:end')
		})
		await first.locked

		const second = withBootstrapLock(
			databaseUrl(),
			async () => {
				events.push('second:start')
				events.push('second:end')
			},
			{ key, pollIntervalMs: 50 },
		)

		await Promise.all([first.done, second])
		expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
	})

	test('a waiter gives up with a clear error rather than hanging forever', async () => {
		const key = testLockKey()
		let settleWaiter!: () => void
		const waiterSettled = new Promise<void>((resolve) => {
			settleWaiter = resolve
		})

		// Hold the lock until the waiter has given up, however long its connect takes, so
		// it can never find the lock free.
		const holder = holdLock(key, () => waiterSettled)
		await holder.locked

		let waiterError = ''
		await withBootstrapLock(databaseUrl(), async () => {}, { key, timeoutMs: 300, pollIntervalMs: 50 })
			.catch((err: Error) => {
				waiterError = err.message
			})
			.finally(settleWaiter)
		await holder.done

		expect(waiterError).toContain('waiting for another process to finish migrating')
	})

	test('the lock is released after a failure, so the next bootstrap is not blocked', async () => {
		const key = testLockKey()
		await expect(
			withBootstrapLock(databaseUrl(), async () => {
				throw new Error('migration failed')
			}, { key }),
		).rejects.toThrow('migration failed')

		const ran = await withBootstrapLock(databaseUrl(), async () => 'ran', { key, timeoutMs: 2_000 })
		expect(ran).toBe('ran')
	})
})

test.describe('db/bootstrap — recognising AgentStudio’s own schema', () => {
	test('every object the migrations create is recognised as AgentStudio’s', async () => {
		// If a migration ever adds something the known set misses (a view, a function, a
		// table created some new way), an old database holding it would be refused at boot
		// as "not AgentStudio's". This catches that on the migrated test database.
		const objects = await listUnmanagedSchemaObjects(getSql())
		const known = getKnownAppObjects(schema)

		const unrecognised = objects.filter(
			(o) =>
				o.schema !== 'public' ||
				!((o.kind === 'table' && known.tables.has(o.name)) || (o.kind === 'enum' && known.enums.has(o.name))),
		)
		expect(unrecognised).toEqual([])

		const tables = new Set(objects.filter((o) => o.kind === 'table').map((o) => o.name))
		for (const core of CORE_APP_TABLES) expect(tables.has(core), core).toBe(true)

		// So had this database lost its migration history, it would be identified — and
		// still only reset with the explicit opt-in. (A pure decision; nothing is executed.)
		const input = { databaseName: 'test', migrationsApplied: false, objects, known }
		expect(planLegacySchemaReconcile({ ...input, allowReset: false }).action).toBe('refuse')
		expect(planLegacySchemaReconcile({ ...input, allowReset: true }).action).toBe('reset')
	})

	test('drizzle’s own bookkeeping table is not counted as an existing schema object', async () => {
		const objects = await listUnmanagedSchemaObjects(getSql())
		expect(objects.some((o) => o.name === '__drizzle_migrations')).toBe(false)
	})

	test('reconcile is a no-op on a database with migration history', async () => {
		const reset = await reconcileLegacySchemaState(getSql(), {
			databaseName: 'test',
			getKnownObjects: () => getKnownAppObjects(schema),
			allowReset: false,
		})
		expect(reset).toBe(false)
	})
})

test.describe('db/bootstrap — health', () => {
	test('/api/health reports the job worker alongside the migration counts', async () => {
		const response = await fetch(TEST_SERVER_HEALTH_URL)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { status: string; jobWorker: string; migrationsInSync: boolean }
		expect(body.status).toBe('ok')
		expect(body.migrationsInSync).toBe(true)
		expect(['running', 'disabled', 'pending']).toContain(body.jobWorker)
	})
})
