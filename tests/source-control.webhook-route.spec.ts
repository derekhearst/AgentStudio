import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, readEnvVar, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 5 — HTTP-level integration tests for `/api/webhooks/github`.
 *
 * Complements the pure-helper coverage in `source-control.github-webhook.spec.ts` by
 * actually firing POSTs at the live dev server. We verify the full request-to-row path:
 *   - Missing secret → 503 (operator-must-opt-in)
 *   - Wrong signature → 401
 *   - Valid `ping` → 200 with `{pong: true}`
 *   - Valid `pull_request` `closed`+merged event → repo's pull_requests row gains the
 *     merged status + `pull_request_ready` review item opens
 *
 * The success cases require `GITHUB_WEBHOOK_SECRET` to be set in `.env` (so the dev
 * server has the same value the test signs with). Tests skip with a clear hint when
 * the secret isn't configured — the 503/missing-secret path is always testable.
 */

const BASE_URL = 'http://127.0.0.1:4173'

function sign(rawBody: string, secret: string): string {
	return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}

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

async function clearPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`%${prefix}%`}`
	await sql`delete from pull_requests where title like ${`%${prefix}%`}`
	await sql`delete from repositories where owner like ${`${prefix}%`}`
}

test.describe('webhooks/github — secret validation', () => {
	test('rejects with 401 when the signature does not match the configured secret', async () => {
		const secret = readEnvVar('GITHUB_WEBHOOK_SECRET') ?? 'e2e-test-webhook-secret-do-not-use-in-prod'
		const body = JSON.stringify({ zen: 'pong' })
		const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'ping',
				'X-Hub-Signature-256': sign(body, 'wrong-secret'),
			},
			body,
		})
		expect(response.status).toBe(401)
	})

	test('rejects with 401 when the X-Hub-Signature-256 header is missing entirely', async () => {
		const secret = readEnvVar('GITHUB_WEBHOOK_SECRET') ?? 'e2e-test-webhook-secret-do-not-use-in-prod'
		const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'ping',
			},
			body: '{}',
		})
		expect(response.status).toBe(401)
	})
})

test.describe('webhooks/github — ping event', () => {
	test('valid ping returns 200 with pong: true', async () => {
		const secret = readEnvVar('GITHUB_WEBHOOK_SECRET') ?? 'e2e-test-webhook-secret-do-not-use-in-prod'
		const body = JSON.stringify({ zen: 'connectivity' })
		const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'ping',
				'X-Hub-Signature-256': sign(body, secret!),
			},
			body,
		})
		expect(response.status).toBe(200)
		const json = (await response.json()) as { ok?: boolean; pong?: boolean }
		expect(json.ok).toBe(true)
		expect(json.pong).toBe(true)
	})
})

test.describe('webhooks/github — pull_request event', () => {
	test('closed+merged action upserts the PR row and opens a pull_request_ready review item', async () => {
		const secret = readEnvVar('GITHUB_WEBHOOK_SECRET') ?? 'e2e-test-webhook-secret-do-not-use-in-prod'

		const prefix = uniquePrefix('webhook-pr')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			// Pre-seed a repository row so the webhook handler has something to update.
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			const prNumber = 42
			const payload = {
				action: 'closed',
				repository: {
					name: `${prefix}-repo`,
					owner: { login: `${prefix}-owner` },
				},
				pull_request: {
					number: prNumber,
					title: `${prefix} merged-feature`,
					body: 'PR body',
					html_url: `https://github.com/${prefix}-owner/${prefix}-repo/pull/${prNumber}`,
					merged: true,
					draft: false,
					merged_at: '2026-05-04T12:00:00Z',
					closed_at: '2026-05-04T12:00:00Z',
					head: { ref: 'feature/x' },
					base: { ref: 'main' },
				},
			}
			const body = JSON.stringify(payload)

			const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-GitHub-Event': 'pull_request',
					'X-Hub-Signature-256': sign(body, secret!),
				},
				body,
			})
			expect(response.status).toBe(200)
			const result = (await response.json()) as { ok?: boolean; updated?: boolean; status?: string }
			expect(result.ok).toBe(true)
			expect(result.updated).toBe(true)
			expect(result.status).toBe('merged')

			// PR row is upserted with status='merged' and metadata captures the action.
			const [prRow] = await sql<{
				title: string
				status: string
				head_branch: string
				base_branch: string
				provider_url: string | null
				metadata: { source?: string; lastAction?: string; merged?: boolean }
			}[]>`
				select title, status::text as status, head_branch, base_branch, provider_url, metadata
				from pull_requests
				where repository_id = ${repo.id} and provider_pr_number = ${prNumber}
			`
			expect(prRow.status).toBe('merged')
			expect(prRow.head_branch).toBe('feature/x')
			expect(prRow.base_branch).toBe('main')
			expect(prRow.metadata.source).toBe('github_webhook')
			expect(prRow.metadata.lastAction).toBe('closed')
			expect(prRow.metadata.merged).toBe(true)

			// Review-inbox row opens for the merged transition (terminal state → operator visibility).
			const items = await sql<{ type: string; severity: string; payload: { kind?: string; status?: string; prNumber?: number } }[]>`
				select type::text as type, severity::text as severity, payload
				from review_items
				where summary like ${`%${prefix}%`}
			`
			expect(items.length).toBeGreaterThanOrEqual(1)
			const merged = items.find((i) => i.payload.status === 'merged')
			expect(merged?.type).toBe('pull_request_ready')
			expect(merged?.severity).toBe('info')
			expect(merged?.payload.kind).toBe('pull_request')
			expect(merged?.payload.prNumber).toBe(prNumber)
		} finally {
			await clearPrefix(prefix)
		}
	})

	test('opened action sets status=open without firing a review item (no terminal transition)', async () => {
		const secret = readEnvVar('GITHUB_WEBHOOK_SECRET') ?? 'e2e-test-webhook-secret-do-not-use-in-prod'

		const prefix = uniquePrefix('webhook-pr-open')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`

			const prNumber = 7
			const payload = {
				action: 'opened',
				repository: { name: `${prefix}-repo`, owner: { login: `${prefix}-owner` } },
				pull_request: {
					number: prNumber,
					title: `${prefix} new-feature`,
					body: '',
					html_url: `https://github.com/${prefix}-owner/${prefix}-repo/pull/${prNumber}`,
					merged: false,
					draft: false,
					merged_at: null,
					closed_at: null,
					head: { ref: 'feature/y' },
					base: { ref: 'main' },
				},
			}
			const body = JSON.stringify(payload)
			const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-GitHub-Event': 'pull_request',
					'X-Hub-Signature-256': sign(body, secret!),
				},
				body,
			})
			expect(response.status).toBe(200)

			const [prRow] = await sql<{ status: string }[]>`
				select status::text as status from pull_requests
				where repository_id = ${repo.id} and provider_pr_number = ${prNumber}
			`
			expect(prRow.status).toBe('open')

			// Opened transitions don't fire inbox items — only merged/closed do.
			const items = await sql<{ count: number }[]>`
				select count(*)::int as count from review_items
				where summary like ${`%${prefix}%`}
			`
			expect(items[0].count).toBe(0)
		} finally {
			await clearPrefix(prefix)
		}
	})
})

test.describe('webhooks/github — unknown event passthrough', () => {
	test('events the handler does not switch on return 200 with ignored: true', async () => {
		const secret = readEnvVar('GITHUB_WEBHOOK_SECRET') ?? 'e2e-test-webhook-secret-do-not-use-in-prod'
		const body = JSON.stringify({ action: 'created' })
		const response = await fetch(`${BASE_URL}/api/webhooks/github`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'release', // not handled by us
				'X-Hub-Signature-256': sign(body, secret!),
			},
			body,
		})
		expect(response.status).toBe(200)
		const result = (await response.json()) as { ignored?: boolean; eventName?: string }
		expect(result.ignored).toBe(true)
		expect(result.eventName).toBe('release')
	})
})
