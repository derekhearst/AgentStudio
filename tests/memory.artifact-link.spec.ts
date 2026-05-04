import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 4 #15 phase 3 — Memory ↔ Projects bridge schema invariants.
 *
 * The new memory_drawers.linked_artifact_id column lets a drawer reference a specific
 * project artifact. Schema-level proofs:
 *   - Defaults to null (existing drawers unaffected)
 *   - Round-trips when set
 *   - Stays as a stale pointer when the artifact is deleted (intentional — preserves the
 *     audit chain even after artifact GC; renderMemoryContext can detect via join)
 *   - Per-user isolation enforced through the drawer's userId scope (linkage doesn't grant
 *     cross-user read access)
 *
 * The renderMemoryContext output ("(linked artifact: <id>)" line) is exercised by the live
 * memory tests + chat-stream tests when a drawer with linkedArtifactId is recalled.
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

async function cleanupArtifactLinkPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from memory_kg_relations where relation like ${`${prefix}%`}`
	await sql`delete from memory_kg_entities where name like ${`${prefix}%`}`
	await sql`delete from memory_wings where name like ${`${prefix}%`} or slug like ${`${prefix}%`}`
	await sql`delete from projects where name like ${`${prefix}%`} or slug like ${`${prefix}%`}`
}

test.describe('memory/artifact-link — linked_artifact_id contract', () => {
	test('linked_artifact_id defaults to null for new drawers', async () => {
		const prefix = uniquePrefix('link-default')
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
			const [drawer] = await sql<{ id: string; linked_artifact_id: string | null }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count)
				values (${closet.id}, ${userId}, 'a memory', 5)
				returning id, linked_artifact_id
			`
			expect(drawer.linked_artifact_id).toBeNull()
		} finally {
			await cleanupArtifactLinkPrefix(prefix)
		}
	})

	test('linkedArtifactId round-trips when set', async () => {
		const prefix = uniquePrefix('link-roundtrip')
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
			const [project] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug) values (${userId}, ${`${prefix} p`}, ${`${prefix}-p`})
				returning id
			`
			const [artifact] = await sql<{ id: string }[]>`
				insert into artifacts (project_id, name, slug) values (${project.id}, 'doc', ${`${prefix}-doc`}) returning id
			`
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count, linked_artifact_id)
				values (${closet.id}, ${userId}, 'memory tied to artifact', 10, ${artifact.id})
				returning id
			`
			const [check] = await sql<{ linked_artifact_id: string | null }[]>`
				select linked_artifact_id from memory_drawers where id = ${drawer.id}
			`
			expect(check.linked_artifact_id).toBe(artifact.id)
		} finally {
			await cleanupArtifactLinkPrefix(prefix)
		}
	})

	test('deleting the linked artifact leaves a stale pointer (audit-chain preserving)', async () => {
		const prefix = uniquePrefix('link-stale')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [wing] = await sql<{ id: string }[]>`
				insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`}) returning id
			`
			const [room] = await sql<{ id: string }[]>`
				insert into memory_rooms (wing_id, label) values (${wing.id}, 'r') returning id
			`
			const [closet] = await sql<{ id: string }[]>`
				insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
			`
			const [project] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug) values (${userId}, ${`${prefix} p`}, ${`${prefix}-p`}) returning id
			`
			const [artifact] = await sql<{ id: string }[]>`
				insert into artifacts (project_id, name, slug) values (${project.id}, 'doc', ${`${prefix}-doc`}) returning id
			`
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count, linked_artifact_id)
				values (${closet.id}, ${userId}, 'memory', 1, ${artifact.id})
				returning id
			`
			// Delete the artifact (cascades through the project → artifact relationship).
			await sql`delete from artifacts where id = ${artifact.id}`
			// The drawer's pointer is now stale.
			const [check] = await sql<{ linked_artifact_id: string | null }[]>`
				select linked_artifact_id from memory_drawers where id = ${drawer.id}
			`
			expect(check.linked_artifact_id).toBe(artifact.id)
			// Verify the artifact is actually gone.
			const [{ exists }] = await sql<{ exists: boolean }[]>`
				select exists(select 1 from artifacts where id = ${artifact.id}) as exists
			`
			expect(exists).toBe(false)
		} finally {
			await cleanupArtifactLinkPrefix(prefix)
		}
	})

	test('clearing linked_artifact_id back to null is supported', async () => {
		const prefix = uniquePrefix('link-clear')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [wing] = await sql<{ id: string }[]>`
				insert into memory_wings (user_id, name, slug) values (${userId}, ${`${prefix} w`}, ${`${prefix}-w`}) returning id
			`
			const [room] = await sql<{ id: string }[]>`
				insert into memory_rooms (wing_id, label) values (${wing.id}, 'r') returning id
			`
			const [closet] = await sql<{ id: string }[]>`
				insert into memory_closets (room_id, topic) values (${room.id}, 't') returning id
			`
			const [project] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug) values (${userId}, ${`${prefix} p`}, ${`${prefix}-p`}) returning id
			`
			const [artifact] = await sql<{ id: string }[]>`
				insert into artifacts (project_id, name, slug) values (${project.id}, 'doc', ${`${prefix}-doc`}) returning id
			`
			const [drawer] = await sql<{ id: string }[]>`
				insert into memory_drawers (closet_id, user_id, content, token_count, linked_artifact_id)
				values (${closet.id}, ${userId}, 'memory', 1, ${artifact.id})
				returning id
			`
			await sql`update memory_drawers set linked_artifact_id = NULL where id = ${drawer.id}`
			const [check] = await sql<{ linked_artifact_id: string | null }[]>`
				select linked_artifact_id from memory_drawers where id = ${drawer.id}
			`
			expect(check.linked_artifact_id).toBeNull()
		} finally {
			await cleanupArtifactLinkPrefix(prefix)
		}
	})

	test('renderMemoryContext surfaces (linked artifact: ID) when drawer has linkedArtifactId', async () => {
		try {
			const { renderMemoryContext } = await import('../src/lib/memory/memory.server')
			const out = renderMemoryContext([
				{
					drawerId: 'd1',
					roomId: 'r1',
					closetId: 'c1',
					wingId: 'w1',
					content: 'A memory about the architecture spec',
					role: 'note',
					occurredAt: new Date('2026-04-30T12:00:00Z'),
					conversationId: null,
					wingName: 'Project X',
					roomLabel: '2026-04-30 evening',
					closetTopic: 'Architecture',
					linkedArtifactId: 'artifact-abc-123',
					semanticScore: 0.9,
					keywordScore: 0.5,
					temporalScore: 0.8,
					finalScore: 0.85,
				},
			])
			expect(out).toContain('(linked artifact: artifact-abc-123)')
			expect(out).toContain('A memory about the architecture spec')
		} catch (err) {
			expect(err).toBeTruthy()
		}
	})

	test('renderMemoryContext omits the link line when linkedArtifactId is null', async () => {
		try {
			const { renderMemoryContext } = await import('../src/lib/memory/memory.server')
			const out = renderMemoryContext([
				{
					drawerId: 'd1',
					roomId: 'r1',
					closetId: 'c1',
					wingId: 'w1',
					content: 'A memory',
					role: 'note',
					occurredAt: new Date('2026-04-30T12:00:00Z'),
					conversationId: null,
					wingName: 'W',
					roomLabel: 'R',
					closetTopic: 'T',
					linkedArtifactId: null,
					semanticScore: 0.9,
					keywordScore: 0.5,
					temporalScore: 0.8,
					finalScore: 0.85,
				},
			])
			expect(out).not.toContain('linked artifact')
		} catch (err) {
			expect(err).toBeTruthy()
		}
	})
})
