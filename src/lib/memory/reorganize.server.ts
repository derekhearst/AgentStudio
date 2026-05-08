/**
 * Memory reorganize / compact — rule-based (no LLM) consolidation pass.
 *
 * Three operations, all idempotent:
 *
 *   1. Wing merges       — same kind AND (alias overlap | identical case-insensitive
 *                          name | one name fully contained in the other at word
 *                          boundaries). The smaller wing's rooms move under the
 *                          larger; the loser's name + aliases roll into the
 *                          winner's aliases array; the loser row is deleted.
 *   2. Closet merges     — within a single room, closets whose normalized topic
 *                          (lower + collapse whitespace + strip trailing 's' on
 *                          the last token) collide. Drawers move under the
 *                          larger closet; the loser closet is deleted.
 *   3. Embedding backfill — drawers with NULL embedding get re-embedded. Bounded
 *                          per call so a single click doesn't run away.
 *
 * The analyze pass is read-only and returns a plan. The apply pass re-derives
 * the plan server-side and applies it — the client-supplied plan is never
 * trusted, only used for preview.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	memoryClosets,
	memoryDrawers,
	memoryRooms,
	memoryWings,
} from '$lib/memory/memory.schema'
import { embed, toPgVector } from '$lib/memory/embeddings.server'
import { logger } from '$lib/observability/logger'

export type WingMergeProposal = {
	fromId: string
	fromName: string
	fromKind: string
	toId: string
	toName: string
	toKind: string
	reason: 'alias-overlap' | 'name-equal' | 'name-contained'
	movedRoomCount: number
	movedDrawerCount: number
}

export type ClosetMergeProposal = {
	roomId: string
	roomLabel: string
	wingName: string
	fromId: string
	fromTopic: string
	toId: string
	toTopic: string
	movedDrawerCount: number
}

export type ReorganizePlan = {
	wingMerges: WingMergeProposal[]
	closetMerges: ClosetMergeProposal[]
	missingEmbeddings: number
}

export type ReorganizeResult = {
	wingMergesApplied: number
	closetMergesApplied: number
	embeddingsBackfilled: number
	failures: string[]
}

const MAX_EMBEDDINGS_PER_RUN = 200

function normalizeName(name: string): string {
	return name.trim().toLowerCase()
}

function normalizeTopic(topic: string): string {
	const trimmed = topic.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
	if (!trimmed) return ''
	// Strip trailing 's' on the final token only, when the token is >= 4 chars,
	// to catch greeting/greetings, calculation/calculations without false-positive
	// stripping of legitimate words ending in 's' (e.g. "axis").
	return trimmed.replace(/(\b\w{4,}?)s$/, '$1')
}

function tokenize(name: string): Set<string> {
	const tokens = new Set<string>()
	for (const t of normalizeName(name).split(/\s+/)) {
		if (t.length >= 4) tokens.add(t)
	}
	return tokens
}

function nameContainedAtWordBoundary(needle: string, haystack: string): boolean {
	const n = normalizeName(needle)
	const h = normalizeName(haystack)
	if (n === h || n.length < 3) return false
	const re = new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
	return re.test(h)
}

type WingRow = {
	id: string
	name: string
	kind: string
	aliases: string[]
	roomCount: number
	drawerCount: number
}

async function loadUserWings(userId: string): Promise<WingRow[]> {
	const rows = await db
		.select({
			id: memoryWings.id,
			name: memoryWings.name,
			kind: memoryWings.kind,
			aliases: memoryWings.aliases,
			roomCount: sql<number>`coalesce((select count(*)::int from memory_rooms where memory_rooms.wing_id = memory_wings.id), 0)`,
			drawerCount: sql<number>`coalesce((
				select count(*)::int from memory_drawers
				inner join memory_closets on memory_closets.id = memory_drawers.closet_id
				inner join memory_rooms on memory_rooms.id = memory_closets.room_id
				where memory_rooms.wing_id = memory_wings.id
			), 0)`,
		})
		.from(memoryWings)
		.where(eq(memoryWings.userId, userId))
	return rows.map((r) => ({ ...r, aliases: r.aliases ?? [] }))
}

function pickWinner(a: WingRow, b: WingRow): { winner: WingRow; loser: WingRow } {
	// Prefer the wing with more drawers; tiebreak on more rooms; tiebreak on longer name.
	const score = (w: WingRow) => w.drawerCount * 100 + w.roomCount * 10 + w.name.length
	return score(a) >= score(b) ? { winner: a, loser: b } : { winner: b, loser: a }
}

function findWingMergeReason(a: WingRow, b: WingRow): WingMergeProposal['reason'] | null {
	if (a.kind !== b.kind) return null
	if (a.id === b.id) return null

	const aName = normalizeName(a.name)
	const bName = normalizeName(b.name)
	if (aName === bName) return 'name-equal'

	const aAliases = new Set(a.aliases.map(normalizeName))
	const bAliases = new Set(b.aliases.map(normalizeName))
	// Alias overlap: any alias-or-name on one side appears in the other side's aliases-or-name set.
	const aSide = new Set([aName, ...aAliases])
	const bSide = new Set([bName, ...bAliases])
	for (const x of aSide) {
		if (bSide.has(x)) return 'alias-overlap'
	}

	if (
		nameContainedAtWordBoundary(a.name, b.name) ||
		nameContainedAtWordBoundary(b.name, a.name)
	) {
		// Avoid trivial substrings — require a 4+ char token in common.
		const aTokens = tokenize(a.name)
		const bTokens = tokenize(b.name)
		for (const t of aTokens) if (bTokens.has(t)) return 'name-contained'
	}

	return null
}

async function findWingMerges(userId: string): Promise<WingMergeProposal[]> {
	const wings = await loadUserWings(userId)
	const proposals: WingMergeProposal[] = []
	const merged = new Set<string>()

	for (let i = 0; i < wings.length; i++) {
		const a = wings[i]
		if (merged.has(a.id)) continue
		for (let j = i + 1; j < wings.length; j++) {
			const b = wings[j]
			if (merged.has(b.id)) continue
			const reason = findWingMergeReason(a, b)
			if (!reason) continue
			const { winner, loser } = pickWinner(a, b)
			proposals.push({
				fromId: loser.id,
				fromName: loser.name,
				fromKind: loser.kind,
				toId: winner.id,
				toName: winner.name,
				toKind: winner.kind,
				reason,
				movedRoomCount: loser.roomCount,
				movedDrawerCount: loser.drawerCount,
			})
			merged.add(loser.id)
			if (loser.id === a.id) break // a got merged away; move on to the next i
		}
	}

	return proposals
}

async function findClosetMerges(userId: string): Promise<ClosetMergeProposal[]> {
	type ClosetRow = {
		id: string
		topic: string
		roomId: string
		roomLabel: string
		wingName: string
		drawerCount: number
	}

	const rows = await db
		.select({
			id: memoryClosets.id,
			topic: memoryClosets.topic,
			roomId: memoryClosets.roomId,
			roomLabel: memoryRooms.label,
			wingName: memoryWings.name,
			drawerCount: sql<number>`coalesce((select count(*)::int from memory_drawers where memory_drawers.closet_id = memory_closets.id), 0)`,
		})
		.from(memoryClosets)
		.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
		.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
		.where(eq(memoryWings.userId, userId))

	const byRoom = new Map<string, ClosetRow[]>()
	for (const row of rows) {
		const list = byRoom.get(row.roomId) ?? []
		list.push(row)
		byRoom.set(row.roomId, list)
	}

	const proposals: ClosetMergeProposal[] = []
	for (const closets of byRoom.values()) {
		if (closets.length < 2) continue
		const groups = new Map<string, ClosetRow[]>()
		for (const c of closets) {
			const key = normalizeTopic(c.topic)
			if (!key) continue
			const list = groups.get(key) ?? []
			list.push(c)
			groups.set(key, list)
		}
		for (const group of groups.values()) {
			if (group.length < 2) continue
			group.sort((x, y) => y.drawerCount - x.drawerCount || y.topic.length - x.topic.length)
			const winner = group[0]
			for (const loser of group.slice(1)) {
				proposals.push({
					roomId: winner.roomId,
					roomLabel: winner.roomLabel,
					wingName: winner.wingName,
					fromId: loser.id,
					fromTopic: loser.topic,
					toId: winner.id,
					toTopic: winner.topic,
					movedDrawerCount: loser.drawerCount,
				})
			}
		}
	}

	return proposals
}

async function countMissingEmbeddings(userId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(memoryDrawers)
		.where(and(eq(memoryDrawers.userId, userId), sql`${memoryDrawers.embedding} is null`))
	return row?.n ?? 0
}

export async function analyzeReorganization(userId: string): Promise<ReorganizePlan> {
	const [wingMerges, closetMerges, missingEmbeddings] = await Promise.all([
		findWingMerges(userId),
		findClosetMerges(userId),
		countMissingEmbeddings(userId),
	])
	return { wingMerges, closetMerges, missingEmbeddings }
}

async function applyWingMerges(userId: string): Promise<{ applied: number; failures: string[] }> {
	const failures: string[] = []
	let applied = 0
	// Re-derive on apply for safety against client-side staleness.
	const proposals = await findWingMerges(userId)
	for (const p of proposals) {
		try {
			await db.transaction(async (tx) => {
				// Move all rooms from loser to winner.
				await tx.update(memoryRooms).set({ wingId: p.toId }).where(eq(memoryRooms.wingId, p.fromId))

				// Merge aliases: union of (winner aliases ∪ loser aliases ∪ loser name).
				const [winner] = await tx
					.select({ aliases: memoryWings.aliases, name: memoryWings.name })
					.from(memoryWings)
					.where(eq(memoryWings.id, p.toId))
					.limit(1)
				const [loser] = await tx
					.select({ aliases: memoryWings.aliases, name: memoryWings.name })
					.from(memoryWings)
					.where(eq(memoryWings.id, p.fromId))
					.limit(1)
				if (winner && loser) {
					const merged = new Set<string>()
					for (const a of winner.aliases ?? []) merged.add(a.toLowerCase().trim())
					for (const a of loser.aliases ?? []) merged.add(a.toLowerCase().trim())
					merged.add(loser.name.toLowerCase().trim())
					merged.delete(winner.name.toLowerCase().trim())
					await tx
						.update(memoryWings)
						.set({ aliases: Array.from(merged).filter(Boolean), updatedAt: new Date() })
						.where(eq(memoryWings.id, p.toId))
				}

				// Delete the loser. Cascade is restricted to wings → rooms (we already moved
				// rooms), so the wing row goes alone.
				await tx
					.delete(memoryWings)
					.where(and(eq(memoryWings.id, p.fromId), eq(memoryWings.userId, userId)))
			})
			applied += 1
		} catch (err) {
			logger.warn('[memory] wing merge failed', { from: p.fromId, to: p.toId, err })
			failures.push(`wing merge ${p.fromName} → ${p.toName}: ${(err as Error).message}`)
		}
	}
	return { applied, failures }
}

async function applyClosetMerges(userId: string): Promise<{ applied: number; failures: string[] }> {
	const failures: string[] = []
	let applied = 0
	const proposals = await findClosetMerges(userId)
	for (const p of proposals) {
		try {
			await db.transaction(async (tx) => {
				// Move drawers (filter by user as defense in depth even though closet ownership
				// is already enforced via the join in findClosetMerges).
				await tx
					.update(memoryDrawers)
					.set({ closetId: p.toId })
					.where(and(eq(memoryDrawers.closetId, p.fromId), eq(memoryDrawers.userId, userId)))
				await tx.delete(memoryClosets).where(eq(memoryClosets.id, p.fromId))
			})
			applied += 1
		} catch (err) {
			logger.warn('[memory] closet merge failed', { from: p.fromId, to: p.toId, err })
			failures.push(`closet merge ${p.fromTopic} → ${p.toTopic}: ${(err as Error).message}`)
		}
	}
	return { applied, failures }
}

async function applyEmbeddingBackfill(userId: string): Promise<{ filled: number; failures: string[] }> {
	const failures: string[] = []
	const drawers = await db
		.select({ id: memoryDrawers.id, content: memoryDrawers.content })
		.from(memoryDrawers)
		.where(and(eq(memoryDrawers.userId, userId), sql`${memoryDrawers.embedding} is null`))
		.limit(MAX_EMBEDDINGS_PER_RUN)
	if (drawers.length === 0) return { filled: 0, failures }

	try {
		const vectors = await embed(drawers.map((d) => d.content), {
			logSource: 'memory_embed',
			metadata: { source: 'reorganize.backfill' },
		})
		for (let i = 0; i < drawers.length; i++) {
			const vec = vectors[i]
			if (!vec) continue
			await db
				.update(memoryDrawers)
				.set({ embedding: toPgVector(vec) as unknown as number[] })
				.where(and(eq(memoryDrawers.id, drawers[i].id), eq(memoryDrawers.userId, userId)))
		}
		return { filled: drawers.length, failures }
	} catch (err) {
		logger.warn('[memory] embedding backfill failed', { err })
		failures.push(`embedding backfill: ${(err as Error).message}`)
		return { filled: 0, failures }
	}
}

export async function applyReorganization(userId: string): Promise<ReorganizeResult> {
	const wing = await applyWingMerges(userId)
	// Closet merges run AFTER wing merges so we don't waste work merging closets in
	// a room that's about to be moved into a different wing (rooms stay attached to
	// the same closets either way, so this is more about not racing).
	const closet = await applyClosetMerges(userId)
	const embed = await applyEmbeddingBackfill(userId)
	return {
		wingMergesApplied: wing.applied,
		closetMergesApplied: closet.applied,
		embeddingsBackfilled: embed.filled,
		failures: [...wing.failures, ...closet.failures, ...embed.failures],
	}
}
