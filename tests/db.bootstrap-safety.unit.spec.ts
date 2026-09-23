import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from '@playwright/test'
import {
	CORE_APP_TABLES,
	LEGACY_SCHEMA_RESET_FLAG,
	collectMigrationObjectNames,
	describeMigrationFailure,
	getKnownAppObjects,
	planLegacySchemaReconcile,
	type KnownAppObjects,
	type SchemaObject,
} from '../src/lib/db/migrations.server'
import {
	DatabaseUnavailableError,
	createBootstrapGate,
	isTransientConnectionError,
	retryOnTransientConnectionError,
} from '../src/lib/db/readiness.server'
import { schema } from '../src/lib/db/schema.server'

/**
 * Database bootstrap safety. No database, no browser: every decision that used to drop
 * data, or swallow a failure, is a pure function now, and this pins each branch.
 *
 * What went wrong before:
 *   - any migration error on a process without NODE_ENV=production ran
 *     `DROP SCHEMA public CASCADE` and re-migrated;
 *   - a database with no migration history and *any* table in `public` — another
 *     application's included — was wiped at boot, in production too;
 *   - a failed bootstrap was logged and forgotten, and `ensureDatabaseReady()` resolved.
 */

const known: KnownAppObjects = {
	tables: new Set([...CORE_APP_TABLES, 'memory_drawers', 'memory_chunks']),
	enums: new Set(['message_role', 'memory_drawer_role']),
}

const table = (name: string, schemaName = 'public'): SchemaObject => ({ schema: schemaName, name, kind: 'table' })
const enumType = (name: string): SchemaObject => ({ schema: 'public', name, kind: 'enum' })
const coreTables = () => CORE_APP_TABLES.map((name) => table(name))

function plan(objects: SchemaObject[], overrides: { migrationsApplied?: boolean; allowReset?: boolean } = {}) {
	return planLegacySchemaReconcile({
		databaseName: 'agentstudiodev',
		migrationsApplied: overrides.migrationsApplied ?? false,
		objects,
		known,
		allowReset: overrides.allowReset ?? false,
	})
}

test.describe('db/bootstrap — legacy schema reconcile', () => {
	test('an empty database is left alone for the migrations to build', () => {
		expect(plan([])).toEqual({ action: 'none' })
		expect(plan([], { allowReset: true })).toEqual({ action: 'none' })
	})

	test('a database with migration history is never reset, whatever it holds', () => {
		const objects = [...coreTables(), table('someone_elses_table')]
		expect(plan(objects, { migrationsApplied: true, allowReset: true })).toEqual({ action: 'none' })
	})

	test('another application’s tables are refused, even with the reset flag set', () => {
		for (const allowReset of [false, true]) {
			const result = plan([table('invoices'), table('customers')], { allowReset })
			expect(result.action).toBe('refuse')
			if (result.action !== 'refuse') continue
			expect(result.reason).toContain('table public.invoices')
			expect(result.reason).toContain('Nothing was changed')
		}
	})

	test('one unknown object among AgentStudio tables is enough to refuse', () => {
		for (const stranger of [
			table('audit_trail'),
			enumType('invoice_status'),
			{ schema: 'public', name: 'some_view', kind: 'view' } as SchemaObject,
			{ schema: 'public', name: 'touch_updated_at', kind: 'function' } as SchemaObject,
			{ schema: 'public', name: 'invoice_number_seq', kind: 'sequence' } as SchemaObject,
			// A domain or composite type that happens to share an AgentStudio enum's name is
			// still not that enum.
			{ schema: 'public', name: 'message_role', kind: 'type' } as SchemaObject,
			table('leftovers', 'drizzle'),
		]) {
			const result = plan([...coreTables(), stranger], { allowReset: true })
			expect(result.action, `${stranger.kind} ${stranger.schema}.${stranger.name}`).toBe('refuse')
		}
	})

	test('familiar table names without the core tables are not proof of AgentStudio', () => {
		// A foreign app with a `users` table is the obvious false positive.
		const result = plan([table('users'), table('messages')], { allowReset: true })
		expect(result.action).toBe('refuse')
		if (result.action === 'refuse') {
			expect(result.reason).toContain('conversations')
		}
	})

	test('a positively identified AgentStudio schema needs the explicit opt-in', () => {
		const objects = [...coreTables(), table('memory_chunks'), enumType('message_role')]

		const refused = plan(objects)
		expect(refused.action).toBe('refuse')
		if (refused.action === 'refuse') {
			expect(refused.reason).toContain(`${LEGACY_SCHEMA_RESET_FLAG}=1`)
			// The restore case: a `pg_dump -n public` backup has data but no drizzle schema.
			expect(refused.reason).toContain('restore')
		}

		const allowed = plan(objects, { allowReset: true })
		expect(allowed).toEqual({ action: 'reset', tables: [...CORE_APP_TABLES, 'memory_chunks'].sort() })
	})
})

test.describe('db/bootstrap — knowing which objects are AgentStudio’s', () => {
	test('migration SQL yields created and renamed tables and enums', () => {
		const names = collectMigrationObjectNames([
			'CREATE TABLE "users" (\n\t"id" uuid PRIMARY KEY\n);',
			'CREATE TABLE IF NOT EXISTS "memory_chunks" ("id" uuid);',
			'CREATE TYPE "public"."message_role" AS ENUM(\'user\', \'assistant\');',
			'ALTER TYPE "automation_mode" RENAME TO "automation_mode_old";',
			'ALTER TABLE "old_name" RENAME TO "new_name";',
			'CREATE INDEX "users_idx" ON "users" USING btree ("id");',
		])
		expect([...names.tables].sort()).toEqual(['memory_chunks', 'new_name', 'users'])
		expect([...names.enums].sort()).toEqual(['automation_mode_old', 'message_role'])
	})

	test('the known set covers the Drizzle schema, the core tables and migration-only leftovers', () => {
		const all = getKnownAppObjects(schema)
		for (const core of CORE_APP_TABLES) expect(all.tables.has(core), core).toBe(true)
		// Declared by the schema.
		expect(all.tables.has('memory_drawers')).toBe(true)
		expect(all.enums.has('memory_drawer_role')).toBe(true)
		// Created by 0010 and never declared in any schema module.
		expect(all.tables.has('memory_chunks')).toBe(true)
		// Dropped by a later migration, but an old database may still hold it.
		expect(all.tables.has('artifact_versions')).toBe(true)
	})
})

test.describe('db/bootstrap — migration failures', () => {
	test('a drift error is explained, and the message says nothing was dropped', () => {
		const error = Object.assign(new Error('index "repositories_project_idx" does not exist'), { code: '42704' })
		const message = describeMigrationFailure(error, 'agentstudiodev')
		expect(message).toContain('"agentstudiodev"')
		expect(message).toContain('42704')
		expect(message).toContain('repositories_project_idx')
		expect(message).toContain('nothing was dropped')
		expect(message).toContain('bun run db:reset')
	})

	test('a non-drift error is reported without the drift advice', () => {
		const message = describeMigrationFailure(Object.assign(new Error('permission denied'), { code: '42501' }), 'x')
		expect(message).toContain('permission denied')
		expect(message).not.toContain('db:reset')
	})

	test('the schema reset has exactly one caller: the flag-gated legacy reconcile', () => {
		// The old bootstrap called resetAppSchemas from its migration catch block. Any new
		// caller outside migrations.server.ts reintroduces an automatic wipe.
		const root = join(process.cwd(), 'src')
		const callers: string[] = []
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry)
				if (statSync(path).isDirectory()) walk(path)
				else if (/\.(ts|svelte)$/.test(entry) && /resetAppSchemas\(/.test(readFileSync(path, 'utf8'))) {
					callers.push(relative(root, path).replaceAll('\\', '/'))
				}
			}
		}
		walk(root)
		expect(callers).toEqual(['lib/db/migrations.server.ts'])

		const source = readFileSync(join(root, 'lib/db/migrations.server.ts'), 'utf8')
		const calls = [...source.matchAll(/await resetAppSchemas\(/g)]
		expect(calls).toHaveLength(1)
		const reconcile = source.slice(source.indexOf('export async function reconcileLegacySchemaState'))
		expect(reconcile).toContain('await resetAppSchemas(')
	})
})

test.describe('db/bootstrap — connection retries', () => {
	const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })

	test('connection-class errors are transient, schema and logic errors are not', () => {
		expect(isTransientConnectionError(refused())).toBe(true)
		expect(isTransientConnectionError(Object.assign(new Error('starting up'), { code: '57P03' }))).toBe(true)
		expect(isTransientConnectionError(new Error('wrapped', { cause: refused() }))).toBe(true)
		// Node's happy-eyeballs connect reports every address it tried.
		expect(isTransientConnectionError(new AggregateError([refused()], 'all failed'))).toBe(true)

		expect(isTransientConnectionError(Object.assign(new Error('drift'), { code: '42704' }))).toBe(false)
		expect(isTransientConnectionError(new Error('Refusing to start'))).toBe(false)
		expect(isTransientConnectionError(undefined)).toBe(false)
	})

	test('retries while the database is unreachable, then succeeds', async () => {
		let calls = 0
		const slept: number[] = []
		const result = await retryOnTransientConnectionError(
			async () => {
				calls++
				if (calls < 3) throw refused()
				return 'ready'
			},
			{ delaysMs: [10, 20, 30], sleep: async (ms) => void slept.push(ms) },
		)
		expect(result).toBe('ready')
		expect(calls).toBe(3)
		expect(slept).toEqual([10, 20])
	})

	test('does not retry a non-transient failure', async () => {
		let calls = 0
		await expect(
			retryOnTransientConnectionError(
				async () => {
					calls++
					throw new Error('Refusing to start: unknown objects')
				},
				{ delaysMs: [10, 20], sleep: async () => {} },
			),
		).rejects.toThrow('Refusing to start')
		expect(calls).toBe(1)
	})

	test('gives up with the last error once the backoff is exhausted', async () => {
		let calls = 0
		await expect(
			retryOnTransientConnectionError(
				async () => {
					calls++
					throw refused()
				},
				{ delaysMs: [1, 1], sleep: async () => {} },
			),
		).rejects.toThrow('ECONNREFUSED')
		expect(calls).toBe(3)
	})
})

test.describe('db/bootstrap — readiness gate', () => {
	test('a failed bootstrap rejects every caller instead of resolving', async () => {
		const gate = createBootstrapGate(async () => {
			throw new Error('connect ECONNREFUSED')
		})
		await expect(gate.ensureReady()).rejects.toBeInstanceOf(DatabaseUnavailableError)
		await expect(gate.ensureReady()).rejects.toThrow('ECONNREFUSED')
		expect(gate.state).toBe('failed')
	})

	test('re-attempts after the cooldown, without the boot backoff, and recovers', async () => {
		let clock = 0
		const attempts: number[] = []
		let databaseUp = false
		const gate = createBootstrapGate(
			async (attempt) => {
				attempts.push(attempt)
				if (!databaseUp) throw new Error('down')
			},
			{ reattemptAfterMs: 1_000, now: () => clock },
		)

		await expect(gate.ensureReady()).rejects.toThrow('down')
		// Inside the cooldown the stored failure is reported; nothing re-runs.
		clock = 500
		await expect(gate.ensureReady()).rejects.toThrow('down')
		expect(attempts).toEqual([0])

		databaseUp = true
		clock = 1_500
		await gate.ensureReady()
		expect(attempts).toEqual([0, 1])
		expect(gate.state).toBe('ready')
	})

	test('success is final: bootstrap runs once however many requests arrive', async () => {
		let runs = 0
		const gate = createBootstrapGate(async () => {
			runs++
		}, { reattemptAfterMs: 0 })
		await Promise.all([gate.ensureReady(), gate.ensureReady(), gate.ensureReady()])
		await gate.ensureReady()
		expect(runs).toBe(1)
		expect(gate.state).toBe('ready')
	})
})
