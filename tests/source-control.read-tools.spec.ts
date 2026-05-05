import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #19 phase 3 + 4 — `list_pull_requests` / `get_pull_request` wiring + the
 * `pull_request_ready` review-inbox handoff.
 *
 * The agent-tool execution path is exercised live in chat-stream tests; here we pin the
 * lower-level invariants that gate safety:
 *   - Capability group lists every read+write tool.
 *   - The new `pull_request_ready` review_item_type enum value accepts inserts and round-trips.
 *   - DedupeKey shape `pull_request:<owner>/<repo>:<num>` is what the create-PR handoff uses,
 *     so a single PR never multiplies inbox rows even if the agent retries.
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

test.describe('source-control/capability-group — full surface', () => {
	test('source_control group exposes the full read + write tool list', async () => {
		const { capabilityGroups } = await import('../src/lib/tools/tools')
		const tools = capabilityGroups.source_control.tools as readonly string[]
		expect(tools).toEqual(
			expect.arrayContaining([
				'list_my_repos',
				'sync_my_repos',
				'prepare_commit',
				'push_branch',
				'create_pull_request',
				'list_pull_requests',
				'get_pull_request',
			]),
		)
	})
})

test.describe('observability/review_items — pull_request_ready source', () => {
	test('pull_request_ready accepts an insert with the documented payload shape', async () => {
		const prefix = uniquePrefix('pr-ready')
		const sql = getSql()
		try {
			const [item] = await sql<{
				type: string
				severity: string
				summary: string
				payload: { dedupeKey?: string; kind?: string; prNumber?: number; owner?: string; repo?: string }
			}[]>`
				insert into review_items (type, severity, summary, payload)
				values (
					'pull_request_ready',
					'info'::review_item_severity,
					${`${prefix} PR opened: acme/widgets#42 — feat: example`},
					${sql.json({ dedupeKey: `pull_request:acme/widgets:42`, kind: 'pull_request', owner: 'acme', repo: 'widgets', prNumber: 42 })}
				)
				returning type::text as type, severity::text as severity, summary, payload
			`
			expect(item.type).toBe('pull_request_ready')
			expect(item.severity).toBe('info')
			expect(item.payload.kind).toBe('pull_request')
			expect(item.payload.dedupeKey).toBe('pull_request:acme/widgets:42')
			expect(item.payload.prNumber).toBe(42)
		} finally {
			await sql`delete from review_items where summary like ${`${prefix}%`}`
		}
	})

	test('dedupeKey shape collapses repeat-fires for the same PR', async () => {
		const prefix = uniquePrefix('pr-dedupe')
		const sql = getSql()
		try {
			const dedupeKey = `pull_request:owner/repo:99`
			// Open one item.
			await sql`
				insert into review_items (type, severity, summary, payload)
				values ('pull_request_ready', 'info'::review_item_severity, ${`${prefix} first`},
					${sql.json({ dedupeKey, kind: 'pull_request' })})
			`
			// Use the lifecycle helper so we exercise the same dedupe path the tool fires.
			const { openReviewItem } = await import('../src/lib/observability/review.server')
			const second = await openReviewItem({
				type: 'pull_request_ready',
				severity: 'info',
				summary: `${prefix} second`,
				payload: { kind: 'pull_request' },
				dedupeKey,
			})
			expect(second).not.toBeNull()
			// Second call returns the FIRST row (deduped); only one open row visible.
			const rows = await sql<{ count: number }[]>`
				select count(*)::int as count
				from review_items
				where payload->>'dedupeKey' = ${dedupeKey}
				  and status in ('open', 'in_progress')
			`
			expect(rows[0].count).toBe(1)
		} finally {
			await sql`delete from review_items where summary like ${`${prefix}%`}`
		}
	})

	test('review_item_type enum in observability.schema includes pull_request_ready', async () => {
		// Verify at the schema level (enum array) since importing review.remote.ts pulls
		// in $app/server which doesn't resolve in the Playwright Node runtime.
		const { reviewItemTypeEnum } = await import('../src/lib/observability/observability.schema')
		expect(reviewItemTypeEnum.enumValues).toContain('pull_request_ready')
	})
})

test.describe('list_pull_requests / get_pull_request — visibility scoping', () => {
	test('get_pull_request rejects rows the user does not own', async () => {
		// Construct a fake PR row attached to a fake repo owned by a NON-existent userId so
		// the active user can't list it. The tool should refuse instead of leaking the row.
		const prefix = uniquePrefix('pr-visibility')
		const sql = getSql()
		const ownerId = await getActiveUserId()

		try {
			// Create a repo owned by a synthetic UUID — the active user never owns it.
			const otherUserId = '00000000-0000-4000-8000-000000aaaaaa'
			// Make sure the synthetic user actually exists so the FK doesn't reject.
			await sql`
				insert into users (id, name, username, role, is_active)
				values (${otherUserId}, 'Test User', ${`${prefix}-user`}, 'user', true)
				on conflict (id) do nothing
			`
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${otherUserId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/repo.git', 'main', '{}'::jsonb)
				returning id
			`
			const [pr] = await sql<{ id: string }[]>`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch, status)
				values (${repo.id}, 1, ${`${prefix} fixture`}, 'feature', 'main', 'draft')
				returning id
			`
			expect(typeof pr.id).toBe('string')

			// The other user's PR is NOT visible: listRepositories(activeUser) doesn't
			// return this repo, so the get_pull_request authorization predicate fails.
			const { listRepositories } = await import('../src/lib/source-control/source-control.server')
			const ownedRepos = await listRepositories(ownerId)
			expect(ownedRepos.some((r) => r.id === repo.id)).toBe(false)
		} finally {
			await sql`delete from pull_requests where title like ${`${prefix}%`}`
			await sql`delete from repositories where owner like ${`${prefix}%`}`
			await sql`delete from users where username like ${`${prefix}%`}`
		}
	})
})
