import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 1 — source-control schema invariants.
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function cleanupRepoPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from repositories where (owner like ${`${prefix}%`}) or (name like ${`${prefix}%`})`
	await sql`delete from repository_connections where provider_account like ${`${prefix}%`}`
}

test.describe('source-control/repositories — invariants', () => {
	test('repository round-trip with all fields', async () => {
		const prefix = uniquePrefix('repo-rt')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [row] = await sql<{
				id: string
				owner: string
				name: string
				provider: string
				default_branch: string
			}[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch)
				values (
					${userId}, 'github'::source_control_provider,
					${`${prefix}-org`}, ${`${prefix}-repo`}, 'https://github.com/o/r.git', 'main'
				)
				returning id, owner, name, provider::text as provider, default_branch
			`
			expect(row.provider).toBe('github')
			expect(row.default_branch).toBe('main')
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})

	test('per-user (owner, name) uniqueness rejects duplicates', async () => {
		const prefix = uniquePrefix('repo-dup')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into repositories (user_id, owner, name, clone_url)
				values (${userId}, ${`${prefix}-org`}, ${`${prefix}-repo`}, 'https://x/y')
			`
			let threw = false
			try {
				await sql`
					insert into repositories (user_id, owner, name, clone_url)
					values (${userId}, ${`${prefix}-org`}, ${`${prefix}-repo`}, 'https://x/y')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})

	test('source_control_provider enum accepts all five values', async () => {
		const prefix = uniquePrefix('repo-providers')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			for (const provider of ['github', 'gitlab', 'bitbucket', 'gitea', 'local'] as const) {
				const [row] = await sql<{ provider: string }[]>`
					insert into repositories (user_id, provider, owner, name, clone_url)
					values (
						${userId}, ${provider}::source_control_provider,
						${`${prefix}-${provider}`}, ${`${prefix}-${provider}`}, 'https://x/y'
					)
					returning provider::text as provider
				`
				expect(row.provider).toBe(provider)
			}
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})
})

test.describe('source-control/connections — provider auth', () => {
	test('connection round-trip with scopes array + status enum', async () => {
		const prefix = uniquePrefix('conn-rt')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [row] = await sql<{
				id: string
				scopes: string[]
				status: string
			}[]>`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status)
				values (
					${userId}, 'github'::source_control_provider,
					${`${prefix}-account`}, 'enc-token', ARRAY['repo', 'workflow'],
					'active'::source_control_connection_status
				)
				returning id, scopes, status::text as status
			`
			expect(row.scopes).toEqual(['repo', 'workflow'])
			expect(row.status).toBe('active')
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})

	test('per-user (provider, account) uniqueness rejects duplicates', async () => {
		const prefix = uniquePrefix('conn-dup')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token)
				values (${userId}, 'github'::source_control_provider, ${`${prefix}-x`}, 'tok')
			`
			let threw = false
			try {
				await sql`
					insert into repository_connections (user_id, provider, provider_account, encrypted_token)
					values (${userId}, 'github'::source_control_provider, ${`${prefix}-x`}, 'tok')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})
})

test.describe('source-control/pull-requests — PR records + checks', () => {
	test('PR + check cascade: deleting the repo trims PRs and checks', async () => {
		const prefix = uniquePrefix('pr-cascade')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, owner, name, clone_url)
				values (${userId}, ${`${prefix}-org`}, ${`${prefix}-repo`}, 'https://x/y')
				returning id
			`
			const [pr] = await sql<{ id: string }[]>`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch)
				values (${repo.id}, 42, ${`${prefix} PR title`}, 'feature', 'main')
				returning id
			`
			await sql`
				insert into pull_request_checks (pull_request_id, check_name, status)
				values
					(${pr.id}, 'ci/test', 'pending'::pull_request_check_status),
					(${pr.id}, 'lint', 'pending'::pull_request_check_status)
			`
			await sql`delete from repositories where id = ${repo.id}`
			const [{ pr_count }] = await sql<{ pr_count: number }[]>`
				select count(*)::int as pr_count from pull_requests where repository_id = ${repo.id}
			`
			const [{ check_count }] = await sql<{ check_count: number }[]>`
				select count(*)::int as check_count from pull_request_checks where pull_request_id = ${pr.id}
			`
			expect(pr_count).toBe(0)
			expect(check_count).toBe(0)
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})

	test('per-repo PR number uniqueness', async () => {
		const prefix = uniquePrefix('pr-dup')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, owner, name, clone_url)
				values (${userId}, ${`${prefix}-org`}, ${`${prefix}-repo`}, 'https://x/y')
				returning id
			`
			await sql`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch)
				values (${repo.id}, 1, ${`${prefix} pr-1`}, 'h', 'main')
			`
			let threw = false
			try {
				await sql`
					insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch)
					values (${repo.id}, 1, ${`${prefix} pr-2`}, 'h2', 'main')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})

	test('cross-domain pointers (task_id, run_id) survive without enforced FK', async () => {
		const prefix = uniquePrefix('pr-pointers')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, owner, name, clone_url)
				values (${userId}, ${`${prefix}-org`}, ${`${prefix}-repo`}, 'https://x/y')
				returning id
			`
			const fakeTaskId = randomUUID()
			const fakeRunId = randomUUID()
			const [pr] = await sql<{ task_id: string | null; run_id: string | null }[]>`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch, task_id, run_id)
				values (${repo.id}, 99, ${`${prefix} pointer-pr`}, 'h', 'main', ${fakeTaskId}, ${fakeRunId})
				returning task_id, run_id
			`
			expect(pr.task_id).toBe(fakeTaskId)
			expect(pr.run_id).toBe(fakeRunId)
		} finally {
			await cleanupRepoPrefix(prefix)
		}
	})
})
