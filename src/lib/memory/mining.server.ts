/**
 * Mining — turns a chat session into Wings/Rooms/Closets/Drawers + AAAK.
 *
 * Ported from MemPalace's `miner.py` + `entity_detector.py`. The pipeline is:
 *   1. For each session (a list of turns + timestamp), call a small LLM to
 *      extract entities (people / projects / topics) + per-turn tags.
 *   2. Map extracted entities to wings (getOrCreateWing).
 *   3. Create one room per (primary wing, session timestamp, conversationId).
 *   4. Group turns into closets by topic.
 *   5. Embed each turn verbatim, encode AAAK, insert as a drawer.
 */

import { count, desc, eq } from 'drizzle-orm'
import { DEFAULT_MODEL, chat } from '$lib/llm/chat.server'
import { db } from '$lib/db.server'
import { logLlmUsage } from '$lib/costs/usage'
import { memoryClosets, memoryDrawers, memoryRooms, memoryWings } from '$lib/memory/memory.schema'
import { getOrCreateCloset, getOrCreateRoom, getOrCreateWing, type WingKind } from '$lib/memory/palace.server'
import { embed, toPgVector } from '$lib/memory/embeddings.server'
import { encodeAaak, type AaakTags } from '$lib/memory/aaak.server'
import { logger } from '$lib/observability/logger'

export type MiningTurn = {
	role: 'user' | 'assistant' | 'system'
	content: string
	hasAnswer?: boolean
	sourceMessageId?: string | null
}

export type MiningSession = {
	conversationId?: string | null
	occurredAt: Date
	sessionLabel?: string
	turns: MiningTurn[]
}

export type MineResult = {
	wingIds: string[]
	roomIds: string[]
	closetIds: string[]
	drawerIds: string[]
}

const EXTRACTOR_BASE = `You are an information extractor for a hierarchical memory system.

Given a conversation session, return STRICT JSON describing:
1. The primary wing — the dominant subject of the session. Pick a kind ("person", "project", or "topic") and a stable canonical name.
2. Per-turn metadata — for every turn (in order), produce a "topic" (1-3 words) plus tag arrays:
   - p: people referenced
   - l: locations referenced
   - e: events referenced
   - i: items / interests / concepts
   - t: explicit timestamps or dates mentioned

Output JSON only — no prose, no code fences.

Schema:
{
  "primaryWing": { "kind": "person|project|topic", "name": "<canonical>", "aliases": ["..."] },
  "turns": [ { "topic": "<short>", "tags": { "p": [], "l": [], "e": [], "i": [], "t": [] } } ]
}`

export type ExtractorWingCandidate = {
	name: string
	kind: string
	aliases: string[]
}

function buildExtractorSystem(existingWings: ExtractorWingCandidate[]): string {
	if (existingWings.length === 0) return EXTRACTOR_BASE
	const lines = existingWings.map((wing) => {
		const aliasPart = wing.aliases.length > 0 ? `, aliases: ${wing.aliases.join(', ')}` : ''
		return `- "${wing.name}" (${wing.kind}${aliasPart})`
	})
	return `${EXTRACTOR_BASE}

The user already has these wings — STRONGLY PREFER reusing one of these exact names if the session's primary subject matches:
${lines.join('\n')}

Only invent a new wing name if the primary subject is genuinely not represented above. When reusing, return the name verbatim.`
}

type ExtractorOutput = {
	primaryWing: { kind: WingKind; name: string; aliases?: string[] }
	turns: Array<{ topic: string; tags: AaakTags }>
}

function fallbackExtraction(session: MiningSession): ExtractorOutput {
	return {
		primaryWing: { kind: 'topic', name: session.sessionLabel ?? 'general', aliases: [] },
		turns: session.turns.map(() => ({ topic: 'general', tags: {} })),
	}
}

function tryParseExtractor(content: string): ExtractorOutput | null {
	const cleaned = content
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
	try {
		const parsed = JSON.parse(cleaned)
		if (parsed && typeof parsed === 'object' && parsed.primaryWing && Array.isArray(parsed.turns)) {
			return parsed as ExtractorOutput
		}
	} catch {
		/* fall through */
	}
	return null
}

async function extractSession(
	session: MiningSession,
	existingWings: ExtractorWingCandidate[] = [],
): Promise<ExtractorOutput> {
	if (session.turns.length === 0) {
		return fallbackExtraction(session)
	}

	const transcript = session.turns.map((turn, i) => `[${i + 1}] ${turn.role.toUpperCase()}: ${turn.content}`).join('\n')

	try {
		const result = await chat([
			{ role: 'system', content: buildExtractorSystem(existingWings) },
			{ role: 'user', content: transcript },
		])

		await logLlmUsage({
			source: 'memory_extract',
			model: DEFAULT_MODEL,
			tokensIn: result.usage?.promptTokens ?? 0,
			tokensOut: result.usage?.completionTokens ?? 0,
			metadata: { conversationId: session.conversationId ?? null, turns: session.turns.length },
		}).catch(() => undefined)

		const text =
			typeof result.content === 'string'
				? result.content
				: Array.isArray(result.content)
					? result.content
							.map((part: unknown) =>
								typeof part === 'object' && part && 'text' in (part as Record<string, unknown>)
									? String((part as { text: unknown }).text)
									: '',
							)
							.join('')
					: ''
		const parsed = tryParseExtractor(text)
		if (parsed && parsed.turns.length > 0) {
			// Tolerate length mismatch: pad with neutral entries or truncate
			if (parsed.turns.length < session.turns.length) {
				const pad = session.turns.length - parsed.turns.length
				for (let i = 0; i < pad; i++) parsed.turns.push({ topic: 'general', tags: {} })
			} else if (parsed.turns.length > session.turns.length) {
				parsed.turns.length = session.turns.length
			}
			return parsed
		}
		logger.warn('[memory] extractor returned unusable JSON, using fallback')
	} catch (error) {
		logger.warn('[memory] extractor call failed', { err: error })
	}

	return fallbackExtraction(session)
}

async function nextDrawerNumber(closetId: string): Promise<number> {
	const [row] = await db.select({ count: count() }).from(memoryDrawers).where(eq(memoryDrawers.closetId, closetId))
	return (row?.count ?? 0) + 1
}

async function nextRoomNumber(wingId: string): Promise<number> {
	const [row] = await db.select({ count: count() }).from(memoryRooms).where(eq(memoryRooms.wingId, wingId))
	return (row?.count ?? 0) + 1
}

async function wingOrdinal(userId: string, wingId: string): Promise<number> {
	const rows = await db
		.select({ id: memoryWings.id })
		.from(memoryWings)
		.where(eq(memoryWings.userId, userId))
		.orderBy(memoryWings.createdAt)
	const idx = rows.findIndex((r) => r.id === wingId)
	return idx >= 0 ? idx + 1 : rows.length
}

export async function mineSession(opts: {
	userId: string
	agentId?: string | null
	session: MiningSession
}): Promise<MineResult> {
	const { userId, agentId, session } = opts
	if (session.turns.length === 0) {
		return { wingIds: [], roomIds: [], closetIds: [], drawerIds: [] }
	}

	const recentWings = await db
		.select({ name: memoryWings.name, kind: memoryWings.kind, aliases: memoryWings.aliases })
		.from(memoryWings)
		.where(eq(memoryWings.userId, userId))
		.orderBy(desc(memoryWings.createdAt))
		.limit(30)
	const candidates: ExtractorWingCandidate[] = recentWings.map((w) => ({
		name: w.name,
		kind: w.kind,
		aliases: w.aliases ?? [],
	}))
	logger.debug('[memory] extractor candidates', { count: candidates.length })

	const extraction = await extractSession(session, candidates)

	const allowedKinds: WingKind[] = ['person', 'project', 'topic', 'agent']
	const wingKind: WingKind = allowedKinds.includes(extraction.primaryWing.kind as WingKind)
		? (extraction.primaryWing.kind as WingKind)
		: 'topic'

	const wing = await getOrCreateWing({
		userId,
		agentId: agentId ?? null,
		kind: wingKind,
		name: extraction.primaryWing.name,
		aliases: extraction.primaryWing.aliases,
	})

	const roomLabel = session.sessionLabel ?? session.occurredAt.toISOString().slice(0, 10)

	const room = await getOrCreateRoom({
		wingId: wing.id,
		label: roomLabel,
		occurredAt: session.occurredAt,
		conversationId: session.conversationId ?? null,
	})

	const wingIndex = await wingOrdinal(userId, wing.id)
	const roomIndex = await nextRoomNumber(wing.id) // approximate ordinal for AAAK pointer

	// Group turns by topic into closets
	const closetCache = new Map<string, string>() // topic -> closetId
	const drawerIds: string[] = []
	const closetIdsSet = new Set<string>()

	const embeddings = await embed(session.turns.map((turn) => turn.content))

	for (let i = 0; i < session.turns.length; i += 1) {
		const turn = session.turns[i]
		const meta = extraction.turns[i] ?? { topic: 'general', tags: {} }
		const topic = meta.topic?.trim() || 'general'

		let closetId = closetCache.get(topic)
		if (!closetId) {
			const closet = await getOrCreateCloset({ roomId: room.id, topic })
			closetId = closet.id
			closetCache.set(topic, closetId)
		}
		closetIdsSet.add(closetId)

		const drawerNumber = await nextDrawerNumber(closetId)
		const aaak = encodeAaak(
			{ wing: wingIndex, room: roomIndex, drawer: drawerNumber },
			{
				...meta.tags,
				t: meta.tags.t && meta.tags.t.length > 0 ? meta.tags.t : [session.occurredAt.toISOString()],
			},
		)

		const embedding = embeddings[i]
		const [drawer] = await db
			.insert(memoryDrawers)
			.values({
				closetId,
				userId,
				role: turn.role,
				content: turn.content,
				embedding: embedding ?? null,
				aaak,
				tokenCount: Math.ceil(turn.content.length / 4),
				sourceMessageId: turn.sourceMessageId ?? null,
				occurredAt: session.occurredAt,
			})
			.returning({ id: memoryDrawers.id })
		drawerIds.push(drawer.id)
	}

	return {
		wingIds: [wing.id],
		roomIds: [room.id],
		closetIds: [...closetIdsSet],
		drawerIds,
	}
}

/** Convenience: mine multiple sessions sequentially. */
export async function mineSessions(opts: {
	userId: string
	agentId?: string | null
	sessions: MiningSession[]
}): Promise<MineResult> {
	const totals: MineResult = { wingIds: [], roomIds: [], closetIds: [], drawerIds: [] }
	for (const session of opts.sessions) {
		const result = await mineSession({ userId: opts.userId, agentId: opts.agentId, session })
		totals.wingIds.push(...result.wingIds)
		totals.roomIds.push(...result.roomIds)
		totals.closetIds.push(...result.closetIds)
		totals.drawerIds.push(...result.drawerIds)
	}
	return totals
}
