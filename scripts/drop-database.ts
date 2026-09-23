import postgres from 'postgres'
import {
	getBootstrapDatabaseUrl,
	getTargetDatabaseName,
	isDisposableDatabaseName,
	quoteIdentifier,
} from '../src/lib/db/migrations.server.ts'

/**
 * Drop the database named in `databaseUrl`, terminating its connections first. Shared by
 * `bun run db:reset` and `bun run db:bootstrap --reset`; development only — nothing in the
 * production image calls it.
 *
 * Only disposable databases can be dropped: the name must end in dev, test or ci and must
 * not contain "prod" (the `agentstudio<env>` rule in docs/database/database.md#databases).
 * Dev and prod share one Postgres server and one role, and a shell-exported DATABASE_URL
 * overrides `.env`, so one stale variable was all it would take to drop production. The
 * check runs before any connection is opened, and there is no override flag on purpose;
 * rename the database or use psql if you really mean it.
 *
 * Connects to the server's `postgres` maintenance database to do it, so the role in the URL
 * needs the right to drop the target (it already needs CREATEDB for the boot pipeline).
 */
export async function dropDatabase(databaseUrl: string, log: (line: string) => void = console.log): Promise<void> {
	const targetDb = getTargetDatabaseName(databaseUrl)
	const targetHost = new URL(databaseUrl).host

	if (!isDisposableDatabaseName(targetDb)) {
		throw new Error(
			`Refusing to drop "${targetDb}" on ${targetHost}: only databases whose name ends in dev, test or ci can be dropped, and never one whose name contains "prod". See docs/database/database.md#databases.`,
		)
	}

	const adminClient = postgres(getBootstrapDatabaseUrl(databaseUrl), { max: 1, prepare: false })
	try {
		log(`Terminating active connections to ${targetDb} on ${targetHost}…`)
		await adminClient`
			SELECT pg_terminate_backend(pid)
			FROM pg_stat_activity
			WHERE datname = ${targetDb} AND pid <> pg_backend_pid()
		`

		log(`Dropping database ${targetDb}…`)
		await adminClient.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDb)}`)
		log(`Dropped ${targetDb}`)
	} finally {
		await adminClient.end({ timeout: 5 })
	}
}
