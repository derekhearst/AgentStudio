import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 2 — schema invariants behind the OAuth-driven connection flow.
 *
 * Validates the round-trip the callback handler relies on:
 *   - upsert seeded with encrypted token + scopes
 *   - re-upsert (re-auth) replaces token + scopes WITHOUT creating duplicates
 *   - disconnect flips status to 'revoked' and clears the token
 *   - sync flow records repos under the right user with idempotent upsert on
 *     (userId, owner, name)
 */

async function getActiveAdminUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function cleanupConnections(userId: string, account: string) {
	const sql = getSql()
	await sql`delete from repository_connections where user_id = ${userId} and provider_account = ${account}`
	await sql`delete from repositories where user_id = ${userId} and owner = ${account}`
}

test.describe('source-control/connection-flow — schema invariants', () => {
	test('upsert with encrypted token persists with active status', async () => {
		const userId = await getActiveAdminUserId()
		const account = `e2e_account_${randomUUID().slice(0, 8)}`
		try {
			const sql = getSql()
			await sql`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status, last_synced_at)
				values (${userId}, 'github'::source_control_provider, ${account}, 'v1:encrypted-payload', ${sql.array(['repo', 'read:user'])}, 'active'::source_control_connection_status, now())
				on conflict (user_id, provider, provider_account) do update set
					encrypted_token = excluded.encrypted_token,
					scopes = excluded.scopes,
					status = 'active'::source_control_connection_status,
					last_synced_at = now(),
					last_error = null,
					updated_at = now()
			`
			const [row] = await sql<{ encrypted_token: string; scopes: string[]; status: string }[]>`
				select encrypted_token, scopes, status::text as status from repository_connections
				where user_id = ${userId} and provider = 'github'::source_control_provider and provider_account = ${account}
			`
			expect(row.status).toBe('active')
			expect(row.encrypted_token).toBe('v1:encrypted-payload')
			expect(row.scopes).toEqual(expect.arrayContaining(['repo', 'read:user']))
		} finally {
			await cleanupConnections(userId, account)
		}
	})

	test('re-upsert replaces token + scopes without creating a duplicate row', async () => {
		const userId = await getActiveAdminUserId()
		const account = `e2e_account_${randomUUID().slice(0, 8)}`
		try {
			const sql = getSql()
			await sql`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status)
				values (${userId}, 'github'::source_control_provider, ${account}, 'v1:first', ${sql.array(['repo'])}, 'active'::source_control_connection_status)
			`
			await sql`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status)
				values (${userId}, 'github'::source_control_provider, ${account}, 'v1:second', ${sql.array(['repo', 'read:org'])}, 'active'::source_control_connection_status)
				on conflict (user_id, provider, provider_account) do update set
					encrypted_token = excluded.encrypted_token,
					scopes = excluded.scopes,
					status = 'active'::source_control_connection_status,
					last_synced_at = now(),
					last_error = null,
					updated_at = now()
			`
			const rows = await sql<{ encrypted_token: string; scopes: string[] }[]>`
				select encrypted_token, scopes from repository_connections
				where user_id = ${userId} and provider = 'github'::source_control_provider and provider_account = ${account}
			`
			expect(rows.length).toBe(1)
			expect(rows[0].encrypted_token).toBe('v1:second')
			expect(rows[0].scopes).toEqual(expect.arrayContaining(['repo', 'read:org']))
		} finally {
			await cleanupConnections(userId, account)
		}
	})

	test('disconnect flips status to revoked + clears token', async () => {
		const userId = await getActiveAdminUserId()
		const account = `e2e_account_${randomUUID().slice(0, 8)}`
		try {
			const sql = getSql()
			await sql`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status)
				values (${userId}, 'github'::source_control_provider, ${account}, 'v1:active-token', ${sql.array(['repo'])}, 'active'::source_control_connection_status)
			`
			// Mimic disconnectGithubForUser
			await sql`
				update repository_connections
				set status = 'revoked'::source_control_connection_status, encrypted_token = '', updated_at = now()
				where user_id = ${userId} and provider = 'github'::source_control_provider
			`
			const [row] = await sql<{ status: string; encrypted_token: string }[]>`
				select status::text as status, encrypted_token from repository_connections
				where user_id = ${userId} and provider = 'github'::source_control_provider and provider_account = ${account}
			`
			expect(row.status).toBe('revoked')
			expect(row.encrypted_token).toBe('')
		} finally {
			await cleanupConnections(userId, account)
		}
	})

	test('repository upsert is idempotent on (userId, owner, name)', async () => {
		const userId = await getActiveAdminUserId()
		const prefix = uniquePrefix('sc-repo-upsert')
		const owner = `e2e-owner-${randomUUID().slice(0, 6)}`
		const name = `${prefix}-repo`
		try {
			const sql = getSql()
			// First insert.
			await sql`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github'::source_control_provider, ${owner}, ${name}, ${`https://github.com/${owner}/${name}.git`}, 'main', ${sql.json({ private: false })})
			`
			// Second "sync" — same (userId, owner, name) — should update, not duplicate.
			await sql`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github'::source_control_provider, ${owner}, ${name}, ${`https://github.com/${owner}/${name}.git`}, 'develop', ${sql.json({ private: true })})
				on conflict (user_id, owner, name) do update set
					default_branch = excluded.default_branch,
					metadata = excluded.metadata,
					updated_at = now()
			`
			const rows = await sql<{ default_branch: string; metadata: { private: boolean } }[]>`
				select default_branch, metadata from repositories
				where user_id = ${userId} and owner = ${owner} and name = ${name}
			`
			expect(rows.length).toBe(1)
			expect(rows[0].default_branch).toBe('develop')
			expect(rows[0].metadata.private).toBe(true)
		} finally {
			const sql = getSql()
			await sql`delete from repositories where owner = ${owner} and name = ${name}`
		}
	})
})
