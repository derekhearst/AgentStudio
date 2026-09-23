import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * What a GitHub webhook delivery may and may not change on a pull request row, and which
 * repository rows it reaches. Server functions called directly against the database; the
 * HTTP route on top is covered by `source-control.webhook-route.spec.ts`.
 *
 * Two bugs this pins:
 *   - Status-irrelevant actions (`synchronize`, `edited`, `labeled`, ...) map to "no status",
 *     and the upsert used to turn "no status" into `draft` and replace the metadata
 *     wholesale — so a label on a merged PR made it a draft again, and the poller's
 *     `headSha` vanished.
 *   - The repository lookup compared owner/name byte-for-byte and ignored the provider, so a
 *     repo imported as `DerekHearst/agentstudio` never heard about `derekhearst/AgentStudio`,
 *     and a same-named repo on another host could be written to.
 */

async function seedRepo(prefix: string, owner: string, name: string, provider = 'github', metadata: object = {}) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [row] = await sql<{ id: string }[]>`
		insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
		values (${userId}, ${provider}::source_control_provider, ${owner}, ${name}, ${`https://example.com/${prefix}.git`}, 'main', ${sql.json(metadata as Record<string, string>)})
		returning id
	`
	return row.id
}

async function cleanup(prefix: string) {
	const sql = getSql()
	await sql`delete from repositories where owner ilike ${`${prefix}%`}`
}

test.describe('source-control/webhook — which repositories a delivery reaches', () => {
	test('matches GitHub rows whatever the casing, and never a same-named repo on another host', async () => {
		const prefix = uniquePrefix('wh-case')
		try {
			const { findGithubRepositoriesForWebhook } = await import('../src/lib/source-control/source-control.server')
			const imported = await seedRepo(prefix, `${prefix}-DerekHearst`, 'agentstudio')
			const otherHost = await seedRepo(prefix, `${prefix}-derekhearst`, 'AgentStudio', 'local')

			const rows = await findGithubRepositoriesForWebhook({ owner: `${prefix}-derekhearst`, name: 'AgentStudio' })
			const ids = rows.map((r) => r.id)
			expect(ids).toContain(imported)
			expect(ids).not.toContain(otherHost)
		} finally {
			await cleanup(prefix)
		}
	})

	test('a synced row is still found by GitHub repo id after a rename', async () => {
		const prefix = uniquePrefix('wh-id')
		try {
			const { findGithubRepositoriesForWebhook } = await import('../src/lib/source-control/source-control.server')
			const providerRepoId = 900_000_000 + Math.floor(Math.random() * 1_000_000)
			const synced = await seedRepo(prefix, `${prefix}-old-owner`, 'old-name', 'github', { providerRepoId })

			const rows = await findGithubRepositoriesForWebhook({ owner: `${prefix}-new-owner`, name: 'new-name', providerRepoId })
			expect(rows.map((r) => r.id)).toEqual([synced])
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('source-control/webhook — what a delivery may change on a PR row', () => {
	test('a status-irrelevant action leaves the status alone and merges metadata', async () => {
		const prefix = uniquePrefix('wh-status')
		try {
			const { recordPullRequest } = await import('../src/lib/source-control/source-control.server')
			const repositoryId = await seedRepo(prefix, `${prefix}-o`, 'r')
			await recordPullRequest({
				repositoryId,
				providerPrNumber: 7,
				title: `${prefix} feature`,
				headBranch: 'feature',
				baseBranch: 'main',
				status: 'merged',
				metadata: { source: 'agent', headSha: 'abc123', lastPolledAt: '2026-09-01T00:00:00Z' },
			})

			// What the route does for `labeled` / `synchronize` / `edited`: no status.
			const after = await recordPullRequest({
				repositoryId,
				providerPrNumber: 7,
				title: `${prefix} feature (renamed)`,
				headBranch: 'feature',
				baseBranch: 'main',
				status: undefined,
				statusIfNew: 'open',
				metadata: { source: 'github_webhook', lastAction: 'labeled' },
			})
			expect(after.status).toBe('merged')
			expect(after.title).toBe(`${prefix} feature (renamed)`)
			expect(after.metadata).toMatchObject({
				source: 'agent',
				headSha: 'abc123',
				lastPolledAt: '2026-09-01T00:00:00Z',
				lastAction: 'labeled',
			})
		} finally {
			await cleanup(prefix)
		}
	})

	test('a PR first seen through a status-irrelevant action is recorded with its real state', async () => {
		const prefix = uniquePrefix('wh-new')
		try {
			const { recordPullRequest } = await import('../src/lib/source-control/source-control.server')
			const repositoryId = await seedRepo(prefix, `${prefix}-o`, 'r')
			const row = await recordPullRequest({
				repositoryId,
				providerPrNumber: 8,
				title: `${prefix} pushed to`,
				headBranch: 'feature',
				baseBranch: 'main',
				status: undefined,
				statusIfNew: 'open',
				metadata: { source: 'github_webhook', lastAction: 'synchronize' },
			})
			expect(row.status).toBe('open')
			expect(row.metadata).toMatchObject({ source: 'github_webhook' })
		} finally {
			await cleanup(prefix)
		}
	})

	test('a status-changing action still moves the status', async () => {
		const prefix = uniquePrefix('wh-move')
		try {
			const { recordPullRequest } = await import('../src/lib/source-control/source-control.server')
			const repositoryId = await seedRepo(prefix, `${prefix}-o`, 'r')
			const base = { repositoryId, providerPrNumber: 9, title: `${prefix} pr`, headBranch: 'f', baseBranch: 'main' }
			await recordPullRequest({ ...base, status: 'open' })
			const merged = await recordPullRequest({ ...base, status: 'merged', metadata: { lastAction: 'closed' } })
			expect(merged.status).toBe('merged')
		} finally {
			await cleanup(prefix)
		}
	})
})

test.describe('source-control/webhook — payload fields', () => {
	test('the PR state and repository id are read from the payload', async () => {
		const { extractPullRequestEventFields, extractCheckRunEventFields } = await import(
			'../src/lib/source-control/github-webhook'
		)
		const pr = extractPullRequestEventFields({
			action: 'labeled',
			repository: { id: 42, name: 'AgentStudio', owner: { login: 'derekhearst' } },
			pull_request: {
				number: 5,
				state: 'closed',
				title: 't',
				html_url: 'https://github.com/derekhearst/AgentStudio/pull/5',
				merged: true,
				draft: false,
				head: { ref: 'f' },
				base: { ref: 'main' },
			},
		})
		expect(pr?.state).toBe('closed')
		expect(pr?.repositoryId).toBe(42)

		const check = extractCheckRunEventFields({
			action: 'completed',
			repository: { id: 42, name: 'AgentStudio', owner: { login: 'derekhearst' } },
			check_run: { id: 1, name: 'ci', status: 'completed', conclusion: 'success', head_sha: 'abc', pull_requests: [] },
		})
		expect(check?.repositoryId).toBe(42)
	})
})
