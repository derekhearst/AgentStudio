import postgres from 'postgres'

/**
 * Drop the database named in `databaseUrl`, terminating its connections first. Shared by
 * `bun run db:reset` and `bun run db:bootstrap --reset`; development only — nothing in the
 * production image calls it.
 *
 * Connects to the server's `postgres` maintenance database to do it, so the role in the URL
 * needs the right to drop the target (it already needs CREATEDB for the boot pipeline).
 */
export function databaseNameOf(databaseUrl: string): string {
	const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, ''))
	if (!name) throw new Error('DATABASE_URL must include a database name')
	return name
}

export async function dropDatabase(databaseUrl: string, log: (line: string) => void = console.log): Promise<void> {
	const targetDb = databaseNameOf(databaseUrl)
	const adminUrl = new URL(databaseUrl)
	adminUrl.pathname = '/postgres'

	const adminClient = postgres(adminUrl.toString(), { max: 1, prepare: false })
	try {
		log(`Terminating active connections to ${targetDb}…`)
		await adminClient`
			SELECT pg_terminate_backend(pid)
			FROM pg_stat_activity
			WHERE datname = ${targetDb} AND pid <> pg_backend_pid()
		`

		log(`Dropping database ${targetDb}…`)
		await adminClient.unsafe(`DROP DATABASE IF EXISTS "${targetDb.replaceAll('"', '""')}"`)
		log(`Dropped ${targetDb}`)
	} finally {
		await adminClient.end({ timeout: 5 })
	}
}
