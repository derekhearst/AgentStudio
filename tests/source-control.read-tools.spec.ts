import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getActiveUserId, getSql, uniquePrefix } from './helpers'

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

test.describe('source-control — registered tool surface', () => {
	test('source-control read + write tools are all registered', async () => {
		const { allToolNames } = await import('../src/lib/tools/tool-schemas')
		expect(allToolNames).toEqual(
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
			// Scoped to the prefix. A fixed literal meant the desktop and mobile projects
			// each inserted a row under the same key, so the "only one open row" assertion
			// counted two and read as a dedupe failure.
			const dedupeKey = `pull_request:${prefix}:99`
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
	test('a repository owned by someone else is not visible to the active user', async () => {
		const prefix = uniquePrefix('pr-visibility')
		const sql = getSql()
		const ownerId = await getActiveUserId()

		try {
			// This used to attach the repo to a synthetic user id on the theory that
			// `repositories.user_id` has no enforced FK. It does — the insert failed with
			// `repositories_user_id_users_id_fk`, and a second user cannot be created
			// either, because a unique index on `(true)` makes `users` single-row.
			//
			// So seed the repo against the real account and ask as a stranger. The
			// ownership predicate is `listRepositories(caller)`, and a caller id needs no
			// user row to be filtered on.
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${ownerId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/repo.git', 'main', '{}'::jsonb)
				returning id
			`
			await sql`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch, status)
				values (${repo.id}, 1, ${`${prefix} fixture`}, 'feature', 'main', 'draft')
			`

			const { listRepositories } = await import('../src/lib/source-control/source-control.server')

			const stranger = randomUUID()
			const strangerRepos = await listRepositories(stranger)
			expect(
				strangerRepos.some((r) => r.id === repo.id),
				'another user must not see this repository',
			).toBe(false)

			// Positive control: the real owner does see it, so a `listRepositories` that
			// returned nothing at all could not pass this test.
			const ownedRepos = await listRepositories(ownerId)
			expect(ownedRepos.some((r) => r.id === repo.id), 'the owner must see it').toBe(true)
		} finally {
			await sql`delete from pull_requests where title like ${`${prefix}%`}`
			await sql`delete from repositories where owner like ${`${prefix}%`}`
		}
	})
})
