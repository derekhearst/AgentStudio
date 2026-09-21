import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Issue #37 — storage contract for the memory control layer.
 *
 * Covers the durable half of "control is what makes a memory system trustworthy":
 *   - drawer pin / never-recall / edited-at defaults and updates
 *   - `never_recall` is honoured by the same predicate recall uses
 *   - exclusion rules: per-user name uniqueness, enable/disable, hit accounting
 *   - recall events cascade away with their drawer (no orphaned provenance)
 */

/** Single-user auth (migration 0050): there is exactly one row in `users`. */
async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`select id from users order by created_at asc limit 1`
	if (!user) throw new Error('No user found')
	return user.id
}

async function cleanupMemoryPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from memory_exclusion_rules where name like ${`${prefix}%`}`
	await sql`delete from memory_wings where name like ${`${prefix}%`} or slug like ${`${prefix}%`}`
}

/** Build wing → room → closet and return the closet id to hang drawers off. */
async function makeCloset(prefix: string, userId: string) {
	const sql = getSql()
	const [wing] = await sql<{ id: string }[]>`
		insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`})
		returning id
	`
	const [room] = await sql<{ id: string }[]>`
		insert into memory_rooms (wing_id, label) values (${wing.id}, 'r') returning id
	`
	const [closet] = await sql<{ id: string }[]>`
		insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
	`
	return { wingId: wing.id, roomId: room.id, closetId: closet.id }
}

test.describe('memory/control — drawer flags', () => {
	test('a new drawer is unpinned, recallable, and unedited by default', async () => {
		const prefix = uniquePrefix('mem-flags-default')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { closetId } = await makeCloset(prefix, userId)
			const [drawer] = await sql<{ pinned: boolean; never_recall: boolean; edited_at: Date | null }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closetId}, ${userId}, 'default flags', 3)
				returning pinned, never_recall, edited_at
			`
			expect(drawer.pinned).toBe(false)
			expect(drawer.never_recall).toBe(false)
			expect(drawer.edited_at).toBeNull()
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('never_recall drawers are excluded by the predicate recall uses', async () => {
		const prefix = uniquePrefix('mem-flags-never')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { closetId } = await makeCloset(prefix, userId)
			const [keep] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closetId}, ${userId}, ${`${prefix} keep me`}, 3) returning id
			`
			const [blocked] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count, never_recall)
				values (${closetId}, ${userId}, ${`${prefix} forget me`}, 3, true) returning id
			`

			const rows = await sql<{ id: string }[]>`
				select id from memory_drawers
				where user_id = ${userId} and never_recall = false and closet_id = ${closetId}
			`
			const ids = rows.map((row) => row.id)
			expect(ids).toContain(keep.id)
			expect(ids).not.toContain(blocked.id)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('editing content stamps edited_at and can clear a stale embedding', async () => {
		const prefix = uniquePrefix('mem-flags-edit')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { closetId } = await makeCloset(prefix, userId)
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closetId}, ${userId}, 'original paraphrase', 5) returning id
			`
			// Mirrors the "re-embed failed" branch: content changes, vector is cleared
			// rather than left pointing at the old wording.
			await sql`
				update memory_drawers
				set content = 'corrected wording', embedding = null, token_count = 4, edited_at = now()
				where id = ${drawer.id}
			`
			const [after] = await sql<{ content: string; edited_at: Date | null; has_embedding: boolean }[]>`
				select content, edited_at, (embedding is not null) as has_embedding
				from memory_drawers where id = ${drawer.id}
			`
			expect(after.content).toBe('corrected wording')
			expect(after.edited_at).not.toBeNull()
			expect(after.has_embedding).toBe(false)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})
})

test.describe('memory/control — exclusion rules', () => {
	test('rules default to enabled, non-builtin, with a zeroed hit counter', async () => {
		const prefix = uniquePrefix('mem-excl-default')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [rule] = await sql<
				{ enabled: boolean; builtin: boolean; hit_count: number; kind: string; last_hit_at: Date | null }[]
			>`
				insert into memory_exclusion_rules (user_id, name, pattern)
				values (${userId}, ${`${prefix} rule`}, 'hunter2')
				returning enabled, builtin, hit_count, kind::text as kind, last_hit_at
			`
			expect(rule.enabled).toBe(true)
			expect(rule.builtin).toBe(false)
			expect(rule.hit_count).toBe(0)
			expect(rule.kind).toBe('regex')
			expect(rule.last_hit_at).toBeNull()
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('per-user (user_id, name) uniqueness makes built-in seeding idempotent', async () => {
		const prefix = uniquePrefix('mem-excl-unique')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into memory_exclusion_rules (user_id, name, pattern, builtin)
				values (${userId}, ${`${prefix} Secret assignment`}, 'a', true)
			`
			// This is the `onConflictDoNothing` path ensureBuiltinExclusionRules relies on:
			// re-seeding must not duplicate or overwrite the user's version.
			await sql`
				insert into memory_exclusion_rules (user_id, name, pattern, builtin)
				values (${userId}, ${`${prefix} Secret assignment`}, 'b', true)
				on conflict (user_id, name) do nothing
			`
			const [{ n }] = await sql<{ n: number }[]>`
				select count(*)::int as n from memory_exclusion_rules where name = ${`${prefix} Secret assignment`}
			`
			expect(n).toBe(1)
			const [row] = await sql<{ pattern: string }[]>`
				select pattern from memory_exclusion_rules where name = ${`${prefix} Secret assignment`}
			`
			expect(row.pattern).toBe('a')

			let threw = false
			try {
				await sql`
					insert into memory_exclusion_rules (user_id, name, pattern)
					values (${userId}, ${`${prefix} Secret assignment`}, 'c')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('hit accounting increments and stamps last_hit_at', async () => {
		const prefix = uniquePrefix('mem-excl-hits')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [rule] = await sql<{ id: string }[]>`
				insert into memory_exclusion_rules (user_id, name, pattern)
				values (${userId}, ${`${prefix} hits`}, 'x') returning id
			`
			await sql`update memory_exclusion_rules set hit_count = hit_count + 3, last_hit_at = now() where id = ${rule.id}`
			const [after] = await sql<{ hit_count: number; last_hit_at: Date | null }[]>`
				select hit_count, last_hit_at from memory_exclusion_rules where id = ${rule.id}
			`
			expect(after.hit_count).toBe(3)
			expect(after.last_hit_at).not.toBeNull()
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('memory_exclusion_kind enum rejects unknown values', async () => {
		const prefix = uniquePrefix('mem-excl-kind')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into memory_exclusion_rules (user_id, name, kind, pattern)
					values (${userId}, ${`${prefix} bad kind`}, 'glob'::memory_exclusion_kind, 'x')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})
})

test.describe('memory/control — recall provenance', () => {
	test('a recall event stores the component scores and the weights in force', async () => {
		const prefix = uniquePrefix('mem-recall-event')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { closetId } = await makeCloset(prefix, userId)
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closetId}, ${userId}, 'recalled thing', 3) returning id
			`
			const [event] = await sql<
				{
					source: string
					semantic_score: number
					keyword_score: number
					temporal_score: number
					final_score: number
					weights: { semantic: number; keyword: number; temporal: number } | null
				}[]
			>`
				insert into memory_recall_events
					(user_id, drawer_id, query, source, rank, semantic_score, keyword_score, temporal_score, final_score, weights)
				values (
					${userId}, ${drawer.id}, 'what did I say about this', 'search'::memory_recall_source, 1,
					0.82, 0.11, 0.04, 0.9,
					${sql.json({ semantic: 1, keyword: 0.35, temporal: 0.25 })}
				)
				returning source::text as source, semantic_score, keyword_score, temporal_score, final_score, weights
			`
			expect(event.source).toBe('search')
			expect(event.semantic_score).toBeCloseTo(0.82, 5)
			expect(event.keyword_score).toBeCloseTo(0.11, 5)
			expect(event.temporal_score).toBeCloseTo(0.04, 5)
			expect(event.final_score).toBeCloseTo(0.9, 5)
			expect(event.weights?.semantic).toBe(1)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('cascade — deleting a drawer removes its recall provenance', async () => {
		const prefix = uniquePrefix('mem-recall-cascade')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { closetId } = await makeCloset(prefix, userId)
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closetId}, ${userId}, 'doomed', 3) returning id
			`
			await sql`
				insert into memory_recall_events (user_id, drawer_id, query)
				values (${userId}, ${drawer.id}, ${`${prefix} query`})
			`
			await sql`delete from memory_drawers where id = ${drawer.id}`
			const [{ remaining }] = await sql<{ remaining: number }[]>`
				select count(*)::int as remaining from memory_recall_events where query = ${`${prefix} query`}
			`
			expect(remaining).toBe(0)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('memory_recall_source enum rejects unknown values', async () => {
		const prefix = uniquePrefix('mem-recall-source')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { closetId } = await makeCloset(prefix, userId)
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closetId}, ${userId}, 'x', 1) returning id
			`
			let threw = false
			try {
				await sql`
					insert into memory_recall_events (user_id, drawer_id, query, source)
					values (${userId}, ${drawer.id}, 'q', 'dream'::memory_recall_source)
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('forgetting a conversation deletes its rooms, closets, and drawers', async () => {
		const prefix = uniquePrefix('mem-forget-convo')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [conversation] = await sql<{ id: string }[]>`
				insert into conversations (user_id, title) values (${userId}, ${`${prefix} chat`}) returning id
			`
			const [wing] = await sql<{ id: string }[]>`
				insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`})
				returning id
			`
			const [room] = await sql<{ id: string }[]>`
				insert into memory_rooms (wing_id, label, conversation_id)
				values (${wing.id}, 'r', ${conversation.id}) returning id
			`
			const [closet] = await sql<{ id: string }[]>`
				insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
			`
			await sql`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closet.id}, ${userId}, ${`${prefix} mined`}, 3)
			`

			// This is exactly what forgetConversationMemories does: delete the rooms and let
			// the cascade take closets and drawers with them.
			await sql`delete from memory_rooms where conversation_id = ${conversation.id}`

			const [{ drawers }] = await sql<{ drawers: number }[]>`
				select count(*)::int as drawers from memory_drawers where content = ${`${prefix} mined`}
			`
			const [{ closets }] = await sql<{ closets: number }[]>`
				select count(*)::int as closets from memory_closets where id = ${closet.id}
			`
			expect(drawers).toBe(0)
			expect(closets).toBe(0)

			await sql`delete from conversations where id = ${conversation.id}`
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})
})
