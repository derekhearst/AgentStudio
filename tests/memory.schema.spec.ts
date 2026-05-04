import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #16 — memory schema invariants for the palace hierarchy + KG.
 *
 * The mining/recall integration is exercised by the existing chat-stream tests + the
 * `/memory` UI smoke tests. This spec pins the durable storage contract so a regression in
 * the migration is caught immediately:
 *
 *   - Wing → Room → Closet → Drawer cascade chain on user delete
 *   - per-user wing slug uniqueness
 *   - per-room closet topic uniqueness
 *   - per-user (entity name, type) uniqueness in the KG
 *   - relation valid_from/valid_to nullability (open-ended relations supported)
 *   - cascade-on-source-drawer-delete trims relations that cite it (SET NULL preserves the relation)
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

async function cleanupMemoryPrefix(prefix: string) {
	const sql = getSql()
	// Cascades trim children when wings/entities are removed.
	await sql`delete from memory_kg_relations where relation like ${`${prefix}%`}`
	await sql`delete from memory_kg_entities where name like ${`${prefix}%`}`
	await sql`delete from memory_wings where name like ${`${prefix}%`} or slug like ${`${prefix}%`}`
}

test.describe('memory/schema — palace hierarchy', () => {
	test('wing → room → closet → drawer chain round-trips with the right defaults', async () => {
		const prefix = uniquePrefix('mem-palace-rt')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [wing] = await sql<{ id: string; kind: string; aliases: string[] }[]>`
				insert into memory_wings (user_id, kind, name, slug, aliases)
				values (${userId}, 'project'::memory_wing_kind, ${`${prefix} efoil`}, ${`${prefix}-efoil`}, ARRAY['efoil', 'foil board'])
				returning id, kind::text as kind, aliases
			`
			expect(wing.kind).toBe('project')
			expect(wing.aliases).toEqual(['efoil', 'foil board'])

			const [room] = await sql<{ id: string }[]>`
				insert into memory_rooms (wing_id, label, summary)
				values (${wing.id}, '2026-04-30 evening', 'Battery wiring research')
				returning id
			`

			const [closet] = await sql<{ id: string; topic: string }[]>`
				insert into memory_closets (room_id, topic, summary)
				values (${room.id}, 'wire gauge', 'compared 12 vs 10 AWG')
				returning id, topic
			`
			expect(closet.topic).toBe('wire gauge')

			const [drawer] = await sql<{ id: string; role: string; token_count: number }[]>`
				insert into memory_drawers (closet_id, user_id, role, content, token_count)
				values (${closet.id}, ${userId}, 'user'::memory_drawer_role, 'I tried 12-AWG silicone wire and it overheated', 12)
				returning id, role::text as role, token_count
			`
			expect(drawer.role).toBe('user')
			expect(drawer.token_count).toBe(12)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('per-user (user_id, slug) wing uniqueness rejects duplicates', async () => {
		const prefix = uniquePrefix('mem-wing-slug-dup')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into memory_wings (user_id, name, slug)
				values (${userId}, ${`${prefix} A`}, ${`${prefix}-shared`})
			`
			let threw = false
			try {
				await sql`
					insert into memory_wings (user_id, name, slug)
					values (${userId}, ${`${prefix} B`}, ${`${prefix}-shared`})
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('per-room (room_id, topic) closet uniqueness rejects duplicates', async () => {
		const prefix = uniquePrefix('mem-closet-topic-dup')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [wing] = await sql<{ id: string }[]>`
				insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`})
				returning id
			`
			const [room] = await sql<{ id: string }[]>`
				insert into memory_rooms (wing_id, label) values (${wing.id}, 'r') returning id
			`
			await sql`insert into memory_closets (room_id, topic) values (${room.id}, 'shared topic')`
			let threw = false
			try {
				await sql`insert into memory_closets (room_id, topic) values (${room.id}, 'shared topic')`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('memory_wing_kind enum rejects unknown values', async () => {
		const prefix = uniquePrefix('mem-wing-kind-bad')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			let threw = false
			try {
				await sql`
					insert into memory_wings (user_id, kind, name, slug)
					values (${userId}, 'thing'::memory_wing_kind, ${`${prefix} x`}, ${`${prefix}-x`})
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('cascade — deleting a wing trims rooms, closets, and drawers', async () => {
		const prefix = uniquePrefix('mem-cascade')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
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
			await sql`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closet.id}, ${userId}, 'first', 1),
				       (${closet.id}, ${userId}, 'second', 2)
			`
			await sql`delete from memory_wings where id = ${wing.id}`
			const [{ rooms }] = await sql<{ rooms: number }[]>`
				select count(*)::int as rooms from memory_rooms where wing_id = ${wing.id}
			`
			const [{ closets }] = await sql<{ closets: number }[]>`
				select count(*)::int as closets from memory_closets where room_id = ${room.id}
			`
			const [{ drawers }] = await sql<{ drawers: number }[]>`
				select count(*)::int as drawers from memory_drawers where closet_id = ${closet.id}
			`
			expect(rooms).toBe(0)
			expect(closets).toBe(0)
			expect(drawers).toBe(0)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})
})

test.describe('memory/schema — temporal knowledge graph', () => {
	test('per-user (name, type) entity uniqueness', async () => {
		const prefix = uniquePrefix('mem-kg-entity-dup')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`
				insert into memory_kg_entities (user_id, name, type)
				values (${userId}, ${`${prefix} efoil`}, 'thing')
			`
			let threw = false
			try {
				await sql`
					insert into memory_kg_entities (user_id, name, type)
					values (${userId}, ${`${prefix} efoil`}, 'thing')
				`
			} catch {
				threw = true
			}
			expect(threw).toBe(true)
			// Same name + different type is allowed.
			await sql`
				insert into memory_kg_entities (user_id, name, type)
				values (${userId}, ${`${prefix} efoil`}, 'project')
			`
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('relation supports open-ended valid window (valid_to null)', async () => {
		const prefix = uniquePrefix('mem-kg-relation-open')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [from] = await sql<{ id: string }[]>`
				insert into memory_kg_entities (user_id, name) values (${userId}, ${`${prefix} derek`}) returning id
			`
			const [to] = await sql<{ id: string }[]>`
				insert into memory_kg_entities (user_id, name) values (${userId}, ${`${prefix} efoil`}) returning id
			`
			const [rel] = await sql<{ id: string; valid_to: Date | null; confidence: number }[]>`
				insert into memory_kg_relations (user_id, from_entity_id, to_entity_id, relation)
				values (${userId}, ${from.id}, ${to.id}, ${`${prefix}-owns`})
				returning id, valid_to, confidence
			`
			expect(rel.valid_to).toBeNull()
			expect(rel.confidence).toBe(1)
			// Closing the relation is a UPDATE, not a DELETE — preserves history.
			await sql`update memory_kg_relations set valid_to = now() where id = ${rel.id}`
			const [closed] = await sql<{ valid_to: Date | null }[]>`
				select valid_to from memory_kg_relations where id = ${rel.id}
			`
			expect(closed.valid_to).not.toBeNull()
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('source_drawer SET NULL on drawer delete preserves the relation', async () => {
		const prefix = uniquePrefix('mem-kg-relation-src-null')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			// Set up a wing → room → closet → drawer chain.
			const [wing] = await sql<{ id: string }[]>`
				insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`}) returning id
			`
			const [room] = await sql<{ id: string }[]>`
				insert into memory_rooms (wing_id, label) values (${wing.id}, 'r') returning id
			`
			const [closet] = await sql<{ id: string }[]>`
				insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
			`
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closet.id}, ${userId}, 'src', 1) returning id
			`

			const [from] = await sql<{ id: string }[]>`
				insert into memory_kg_entities (user_id, name) values (${userId}, ${`${prefix} A`}) returning id
			`
			const [to] = await sql<{ id: string }[]>`
				insert into memory_kg_entities (user_id, name) values (${userId}, ${`${prefix} B`}) returning id
			`
			const [rel] = await sql<{ id: string }[]>`
				insert into memory_kg_relations (user_id, from_entity_id, to_entity_id, relation, source_drawer_id)
				values (${userId}, ${from.id}, ${to.id}, ${`${prefix}-cites`}, ${drawer.id})
				returning id
			`

			// Delete the source drawer — the relation should survive with source_drawer_id = NULL.
			await sql`delete from memory_drawers where id = ${drawer.id}`
			const [check] = await sql<{ source_drawer_id: string | null }[]>`
				select source_drawer_id from memory_kg_relations where id = ${rel.id}
			`
			expect(check.source_drawer_id).toBeNull()
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})

	test('cascade — deleting an entity trims relations that reference it', async () => {
		const prefix = uniquePrefix('mem-kg-entity-cascade')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [from] = await sql<{ id: string }[]>`
				insert into memory_kg_entities (user_id, name) values (${userId}, ${`${prefix} A`}) returning id
			`
			const [to] = await sql<{ id: string }[]>`
				insert into memory_kg_entities (user_id, name) values (${userId}, ${`${prefix} B`}) returning id
			`
			await sql`
				insert into memory_kg_relations (user_id, from_entity_id, to_entity_id, relation)
				values (${userId}, ${from.id}, ${to.id}, ${`${prefix}-rel`})
			`
			await sql`delete from memory_kg_entities where id = ${from.id}`
			const [{ remaining }] = await sql<{ remaining: number }[]>`
				select count(*)::int as remaining from memory_kg_relations
				where relation = ${`${prefix}-rel`}
			`
			expect(remaining).toBe(0)
		} finally {
			await cleanupMemoryPrefix(prefix)
		}
	})
})
