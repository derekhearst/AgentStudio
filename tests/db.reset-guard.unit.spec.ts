import { spawnSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { isDisposableDatabaseName } from '../src/lib/db/migrations.server'

/**
 * `bun run db:reset` guard (#3). Dev and prod live on one Postgres server under one role,
 * and a shell-exported DATABASE_URL overrides `.env`, so one stale variable plus
 * `db:reset` could drop production. The script now refuses any database whose name
 * does not follow the disposable half of the `agentstudio<env>` rule. The check lives in
 * `dropDatabase` (scripts/drop-database.ts), so `db:bootstrap --reset` refuses the same way.
 *
 * No database: the refusal happens before the script opens a connection, and the URLs
 * below point at a port nothing listens on, so a broken guard fails to connect rather
 * than dropping anything.
 */

test.describe('db:reset — disposable database names', () => {
	test('dev, test and ci databases may be reset', () => {
		for (const name of ['agentstudiodev', 'agentstudiotest', 'agentstudio_ci', 'AgentStudioDev']) {
			expect(isDisposableDatabaseName(name), name).toBe(true)
		}
	})

	test('production, legacy and unrelated databases may not', () => {
		for (const name of [
			'agentstudioprod',
			'agentstudio_prod',
			'agentstudioprod_dev', // ends in dev, but mentions prod
			'prodtest',
			'AGENTSTUDIO',
			'AgentStudio',
			'agentstudio',
			'drokbot',
			'postgres',
		]) {
			expect(isDisposableDatabaseName(name), name).toBe(false)
		}
	})

	test('the script refuses a production name before connecting and exits non-zero', () => {
		// `--no-env-file` so the developer's `.env` can never stand in for the URL below.
		// (Bun already lets the real environment win; this makes it not matter.)
		const result = spawnSync('bun', ['--no-env-file', 'scripts/reset-and-bootstrap.ts'], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/agentstudioprod' },
			encoding: 'utf8',
			timeout: 60_000,
		})
		expect(result.status).toBe(1)
		expect(result.stderr).toContain('Refusing to drop "agentstudioprod" on 127.0.0.1:1')
		expect(result.stdout).not.toContain('Dropping database')
	})

	test('db:bootstrap --reset refuses a production name the same way', () => {
		const result = spawnSync('bun', ['--no-env-file', 'scripts/bootstrap-dev.ts', '--reset', '--password', 'unused'], {
			cwd: process.cwd(),
			env: {
				...process.env,
				NODE_ENV: 'development',
				DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/agentstudioprod',
			},
			encoding: 'utf8',
			timeout: 60_000,
		})
		expect(result.status).toBe(1)
		expect(result.stderr).toContain('Refusing to drop "agentstudioprod" on 127.0.0.1:1')
		expect(result.stdout).not.toContain('Dropping database')
	})
})
