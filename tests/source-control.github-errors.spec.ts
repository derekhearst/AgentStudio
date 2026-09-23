import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, readEnvVar } from './helpers'

/**
 * Which GitHub failures take a connection out of service.
 *
 * A connection marked `error` makes every later push, PR, clone and poll see "no GitHub
 * connection" until the user re-runs OAuth — the sync cannot heal it, because the sync
 * itself needs an active connection. It used to happen on ANY exception from the repo
 * listing: a 502, a 20-second timeout, a rate-limit 403. Now only a failure that says the
 * token itself is bad qualifies.
 */

function response(status: number, headers: Record<string, string> = {}): Response {
	return new Response(status === 200 ? '[]' : '{"message":"x"}', { status, headers })
}

/** GitHub's documented secondary-limit 403: no rate-limit headers, only the message. */
function secondaryLimit(): Response {
	return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }), {
		status: 403,
	})
}

test.describe('source-control/github-api — classifying failures', () => {
	test('rate limits are recognised from GitHub’s headers', async () => {
		const { isRateLimitResponse } = await import('../src/lib/source-control/github-api.server')
		expect(isRateLimitResponse(response(429))).toBe(true)
		expect(isRateLimitResponse(response(403, { 'x-ratelimit-remaining': '0' }))).toBe(true)
		expect(isRateLimitResponse(response(403, { 'retry-after': '60' }))).toBe(true)
		expect(isRateLimitResponse(response(403, { 'x-ratelimit-remaining': '4999' }))).toBe(false)
		expect(isRateLimitResponse(response(502))).toBe(false)
	})

	test('a secondary-limit 403 with neither header is recognised from its message', async () => {
		const { isRateLimitResponse } = await import('../src/lib/source-control/github-api.server')
		const bare = { status: 403, headers: new Headers() }
		expect(
			isRateLimitResponse(bare, JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' })),
		).toBe(true)
		expect(isRateLimitResponse(bare, JSON.stringify({ message: 'You have triggered an abuse detection mechanism.' }))).toBe(true)
		expect(isRateLimitResponse(bare, JSON.stringify({ message: 'Resource protected by organization SAML enforcement.' }))).toBe(
			false,
		)
		expect(isRateLimitResponse(bare, '')).toBe(false)
	})

	test('only a dead token counts as a credential failure', async () => {
		const { GithubApiError, isGithubCredentialFailure } = await import('../src/lib/source-control/github-api.server')
		expect(isGithubCredentialFailure(new GithubApiError('bad credentials', 401))).toBe(true)
		expect(isGithubCredentialFailure(new GithubApiError('forbidden', 403))).toBe(true)
		expect(isGithubCredentialFailure(new GithubApiError('rate limited', 403, true))).toBe(false)
		expect(isGithubCredentialFailure(new GithubApiError('bad gateway', 502))).toBe(false)
		expect(isGithubCredentialFailure(new Error('The operation was aborted'))).toBe(false)
		// On one repository or PR, a 403 is about that resource (SSO, org app restrictions).
		expect(isGithubCredentialFailure(new GithubApiError('forbidden', 403), 'resource')).toBe(false)
		expect(isGithubCredentialFailure(new GithubApiError('bad credentials', 401), 'resource')).toBe(true)
	})

	test('the repo listing carries the rate-limit fact on the error it throws', async () => {
		const { listAuthenticatedUserRepos } = await import('../src/lib/source-control/github-api.server')
		const realFetch = globalThis.fetch
		globalThis.fetch = (async () => response(403, { 'x-ratelimit-remaining': '0' })) as typeof fetch
		try {
			await expect(listAuthenticatedUserRepos('tok')).rejects.toMatchObject({ status: 403, rateLimited: true })
			// The body is read too: a secondary limit can say so only in its message.
			globalThis.fetch = (async () => secondaryLimit()) as typeof fetch
			await expect(listAuthenticatedUserRepos('tok')).rejects.toMatchObject({ status: 403, rateLimited: true })
		} finally {
			globalThis.fetch = realFetch
		}
	})
})

test.describe('source-control/github-provider — a failed sync and the connection', () => {
	test('a 502, a timeout or a rate limit leaves the connection active; a 401 does not', async () => {
		const sql = getSql()
		const userId = await getActiveUserId()
		const account = `e2e_sync_${randomUUID().slice(0, 8)}`
		const previousKey = process.env.APP_ENCRYPTION_KEY
		process.env.APP_ENCRYPTION_KEY = previousKey || readEnvVar('APP_ENCRYPTION_KEY') || 'e2e-test-encryption-key'
		const realFetch = globalThis.fetch
		try {
			const { encryptSecret } = await import('../src/lib/source-control/encryption.server')
			const { syncGithubReposForUser } = await import('../src/lib/source-control/github-provider.server')
			// Dated ahead so it is the connection `getActiveGithubConnection` picks. Only this
			// row can be touched; the 401 case, which does mark it, runs last.
			const [conn] = await sql<{ id: string }[]>`
				insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status, updated_at)
				values (${userId}, 'github'::source_control_provider, ${account}, ${encryptSecret('gho_test')}, ${sql.array(['repo'])},
					'active'::source_control_connection_status, now() + interval '1 day')
				returning id
			`
			const statusOf = async () =>
				(await sql<{ status: string }[]>`select status::text as status from repository_connections where id = ${conn.id}`)[0]
					.status

			for (const transient of [
				async () => response(502),
				async () => response(403, { 'x-ratelimit-remaining': '0' }),
				async () => secondaryLimit(),
				async () => {
					throw new DOMException('The operation was aborted.', 'AbortError')
				},
			]) {
				globalThis.fetch = transient as typeof fetch
				const summary = await syncGithubReposForUser(userId)
				expect(summary.errorMessage).toBeTruthy()
				expect(await statusOf()).toBe('active')
			}

			globalThis.fetch = (async () => response(401)) as typeof fetch
			const summary = await syncGithubReposForUser(userId)
			expect(summary.errorMessage).toMatch(/401/)
			expect(await statusOf()).toBe('error')
		} finally {
			globalThis.fetch = realFetch
			if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY
			else process.env.APP_ENCRYPTION_KEY = previousKey
			await sql`delete from repository_connections where user_id = ${userId} and provider_account = ${account}`
		}
	})
})
