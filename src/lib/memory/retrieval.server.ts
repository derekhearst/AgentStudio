/**
 * Hybrid retrieval — semantic + keyword + temporal proximity.
 *
 * Ported from MemPalace's `searcher.py`. Pipeline:
 *   1. Cosine similarity top-N via pgvector `<=>`.
 *   2. Keyword (BM25-ish) boost via Postgres tsvector `@@`.
 *   3. Temporal proximity boost using `question_date` vs drawer.occurredAt.
 *   4. Optional preference-pattern boost (last-mentioned wins).
 *
 * User control (issue #37):
 *   - drawers flagged `never_recall` are excluded from the candidate pool entirely;
 *   - drawers flagged `pinned` are force-added to the pool even when they fall outside
 *     the vector top-N, and receive a configurable additive boost.
 *
 * The HNSW index on `memory_drawers.embedding` covers every drawer in the table, and pgvector
 * applies the WHERE clause (this user, recallable) *after* the index scan, which by default
 * returns only `hnsw.ef_search` (40) rows. When those 40 were mostly drawers recall must skip
 * (never-recall ones, or another palace's in a shared database), a palace could get a handful
 * of candidates or none. `nearestRecallable` searches a small palace exactly, lets the scan of
 * a bigger one keep going until the pool is full, and falls back to the exact search when it
 * still comes up short.
 *
 * Returns ranked drawer rows joined back to room/closet/wing for context, each carrying
 * its component scores so a bad recall can be explained after the fact.
 */

import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations } from '$lib/sessions/sessions.schema'
import { memoryClosets, memoryDrawers, memoryRooms, memoryWings } from '$lib/memory/memory.schema'
import { embedOne, toPgVector } from '$lib/memory/embeddings.server'

export type RetrievedDrawer = {
	drawerId: string
	roomId: string
	closetId: string
	wingId: string
	content: string
	role: 'user' | 'assistant' | 'system' | 'note'
	occurredAt: Date
	conversationId: string | null
	wingName: string
	roomLabel: string
	closetTopic: string
	pinned: boolean
	semanticScore: number
	keywordScore: number
	temporalScore: number
	/** Additive boost applied because the drawer is pinned (0 when it is not). */
	pinnedBoost: number
	finalScore: number
}

export type RecallOptions = {
	topK?: number
	candidatePoolSize?: number
	semanticWeight?: number
	keywordWeight?: number
	temporalWeight?: number
	queryDate?: Date
	temporalDecayDays?: number
	preferenceBoost?: boolean
	/** Additive score bonus for pinned drawers. */
	pinnedBoost?: number
	/** Cap on how many pinned drawers are force-added to the candidate pool. */
	pinnedPoolSize?: number
}

export const RECALL_DEFAULTS = {
	topK: 5,
	candidatePoolSize: 50,
	semanticWeight: 1,
	keywordWeight: 0.35,
	temporalWeight: 0.25,
	temporalDecayDays: 30,
	preferenceBoost: true,
	pinnedBoost: 0.15,
	pinnedPoolSize: 25,
}

const DEFAULTS = RECALL_DEFAULTS

function temporalScore(occurredAt: Date, queryDate: Date | undefined, decayDays: number): number {
	if (!queryDate) return 0
	const deltaDays = Math.abs(queryDate.getTime() - occurredAt.getTime()) / (1000 * 60 * 60 * 24)
	// proximity in [0,1]: exp(-delta/decay)
	return Math.exp(-deltaDays / Math.max(1, decayDays))
}

type Executor = typeof db | Parameters<Parameters<(typeof db)['transaction']>[0]>[0]

/** pgvector's ceiling for `hnsw.ef_search`. */
const MAX_EF_SEARCH = 1000

/**
 * A palace with at most this many recallable drawers is searched exactly, without the index.
 * Comparing the query with a couple of thousand vectors is cheap; walking the shared index for
 * a pool it can never fill (a palace smaller than the pool) costs up to `hnsw.max_scan_tuples`
 * (20,000 by default) on every recall before the exact search runs anyway.
 */
export const EXACT_SEARCH_MAX_DRAWERS = 2_000

let iterativeScanSupport: Promise<boolean> | null = null

/**
 * Whether the installed pgvector has iterative index scans (0.8.0+). Older versions reject the
 * `hnsw.iterative_scan` setting outright, so it is only set when it exists. Asked once per
 * process; a failed lookup is asked again next time.
 */
function supportsIterativeScan(): Promise<boolean> {
	iterativeScanSupport ??= db
		.execute<{ extversion: string }>(sql`select extversion from pg_extension where extname = 'vector'`)
		.then((rows) => {
			const [major = 0, minor = 0] = String(rows[0]?.extversion ?? '0.0')
				.split('.')
				.map(Number)
			return major > 0 || minor >= 8
		})
		.catch(() => {
			iterativeScanSupport = null
			return false
		})
	return iterativeScanSupport
}

/**
 * The `limit` recallable drawers nearest `vec`, by cosine distance.
 *
 * A palace of at most `exactAtMost` recallable drawers (`countUpTo` counts them, stopping one
 * past that) is searched exactly, straight away. Adding `+ 0` to the distance is what makes it
 * exact: the index can only serve `ORDER BY embedding <=> …` as written, so the planner reads
 * the user's rows and sorts.
 *
 * A bigger one goes through the HNSW index, told to keep scanning until `limit` rows pass the
 * filter (`hnsw.iterative_scan`, pgvector 0.8+; `relaxed_order` is fine because recall
 * re-scores and re-sorts everything) and to consider at least `limit` candidates
 * (`hnsw.ef_search`). Both are set for the transaction only (`set_config(…, true)`, i.e.
 * `SET LOCAL`), so they never outlive it on a pooled connection. If that still returns fewer
 * than `limit` — pgvector older than 0.8, or recallable drawers sitting beyond the scan's
 * tuple budget among ones recall must skip — the answer comes from the exact search instead.
 *
 * Exported for the specs, which drive each branch.
 */
export async function nearestRecallable<T>(opts: {
	query: (orderBy: SQL, run: Executor) => Promise<T[]>
	countUpTo: (atMost: number) => Promise<number>
	vec: string
	limit: number
	exactAtMost?: number
}): Promise<T[]> {
	const { query, vec, limit } = opts
	const exactAtMost = opts.exactAtMost ?? EXACT_SEARCH_MAX_DRAWERS
	const exact = () => query(sql`(${memoryDrawers.embedding} <=> ${vec}::vector) + 0`, db)

	if ((await opts.countUpTo(exactAtMost + 1)) <= exactAtMost) return exact()

	const iterative = await supportsIterativeScan()
	const efSearch = Math.min(MAX_EF_SEARCH, Math.max(40, limit))
	const viaIndex = await db.transaction(async (tx) => {
		await tx.execute(sql`select set_config('hnsw.ef_search', ${String(efSearch)}, true)`)
		if (iterative) await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`)
		return query(sql`${memoryDrawers.embedding} <=> ${vec}::vector`, tx)
	})
	if (viaIndex.length >= limit) return viaIndex
	return exact()
}

/**
 * How many rows match `where` in `memory_drawers`, counting no further than `atMost` — so the
 * question "is this palace small?" costs the same for a palace of a million drawers.
 */
async function countDrawersUpTo(where: SQL | undefined, atMost: number): Promise<number> {
	const capped = db.select({ one: sql`1` }).from(memoryDrawers).where(where).limit(atMost).as('capped')
	const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(capped)
	return Number(row?.n ?? 0)
}

function buildTsQuery(query: string): string {
	// Naive tokenizer: split on whitespace, drop short tokens, OR-join.
	const tokens = query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((token) => token.length >= 3)
	if (tokens.length === 0) return ''
	return tokens.map((token) => `${token}:*`).join(' | ')
}

export async function recall(userId: string, query: string, options: RecallOptions = {}): Promise<RetrievedDrawer[]> {
	const opts = { ...DEFAULTS, ...options }
	// The query is the user's message as typed: embedded once, so there is nothing to gain from
	// asking OpenRouter to keep it for a day.
	const queryEmbedding = await embedOne(query, { cache: false })
	const vec = toPgVector(queryEmbedding)
	const tsQuery = buildTsQuery(query)

	// pgvector cosine distance: smaller is closer. Convert to similarity (1 - distance).
	const semanticExpr = sql<number>`1 - (${memoryDrawers.embedding} <=> ${vec}::vector)`
	const keywordExpr = tsQuery
		? sql<number>`coalesce(ts_rank(to_tsvector('english', ${memoryDrawers.content}), to_tsquery('english', ${tsQuery})), 0)`
		: sql<number>`0`

	const selection = {
		drawerId: memoryDrawers.id,
		roomId: memoryRooms.id,
		closetId: memoryClosets.id,
		wingId: memoryWings.id,
		content: memoryDrawers.content,
		role: memoryDrawers.role,
		occurredAt: memoryDrawers.occurredAt,
		conversationId: memoryRooms.conversationId,
		wingName: memoryWings.name,
		roomLabel: memoryRooms.label,
		closetTopic: memoryClosets.topic,
		pinned: memoryDrawers.pinned,
		semantic: semanticExpr,
		keyword: keywordExpr,
	}

	// `never_recall` drawers stay visible in the palace but are hard-excluded here: the
	// filter lives in the candidate query so they can never reach a prompt.
	const recallable = and(
		eq(memoryDrawers.userId, userId),
		eq(memoryDrawers.neverRecall, false),
		sql`${memoryDrawers.embedding} IS NOT NULL`,
	)

	const drawersWhere = (
		where: SQL | undefined,
		orderBy: SQL,
		limit: number,
		run: Executor = db,
	) =>
		run
			.select(selection)
			.from(memoryDrawers)
			.innerJoin(memoryClosets, eq(memoryClosets.id, memoryDrawers.closetId))
			.innerJoin(memoryRooms, eq(memoryRooms.id, memoryClosets.roomId))
			.innerJoin(memoryWings, eq(memoryWings.id, memoryRooms.wingId))
			.where(where)
			.orderBy(orderBy)
			.limit(limit)

	const rows = await nearestRecallable({
		query: (orderBy, run) => drawersWhere(recallable, orderBy, opts.candidatePoolSize, run),
		countUpTo: (atMost) => countDrawersUpTo(recallable, atMost),
		vec,
		limit: opts.candidatePoolSize,
	})

	// Pinned drawers are the user saying "always consider this". A boost alone would not
	// deliver that, because a drawer outside the vector top-N never enters the pool at
	// all — so fetch them explicitly and merge. Exact (`+ 0`, see `nearestRecallable`): an
	// index scan would only see pinned drawers among the nearest few of everyone's.
	const pinnedRows =
		opts.pinnedPoolSize > 0
			? await drawersWhere(
					and(recallable, eq(memoryDrawers.pinned, true)),
					sql`(${memoryDrawers.embedding} <=> ${vec}::vector) + 0`,
					opts.pinnedPoolSize,
				)
			: []

	const seen = new Set(rows.map((row) => row.drawerId))
	const candidates = [...rows]
	for (const row of pinnedRows) {
		if (seen.has(row.drawerId)) continue
		seen.add(row.drawerId)
		candidates.push(row)
	}

	const scored: RetrievedDrawer[] = candidates.map((row) => {
		const semantic = Number(row.semantic ?? 0)
		const keyword = Number(row.keyword ?? 0)
		const temporal = temporalScore(row.occurredAt, opts.queryDate, opts.temporalDecayDays)
		const pinnedBoost = row.pinned ? opts.pinnedBoost : 0
		const finalScore =
			opts.semanticWeight * semantic + opts.keywordWeight * keyword + opts.temporalWeight * temporal + pinnedBoost
		return {
			drawerId: row.drawerId,
			roomId: row.roomId,
			closetId: row.closetId,
			wingId: row.wingId,
			content: row.content,
			role: row.role,
			occurredAt: row.occurredAt,
			conversationId: row.conversationId,
			wingName: row.wingName,
			roomLabel: row.roomLabel,
			closetTopic: row.closetTopic,
			pinned: row.pinned,
			semanticScore: semantic,
			keywordScore: keyword,
			temporalScore: temporal,
			pinnedBoost,
			finalScore,
		}
	})

	// Optional preference-pattern boost: when multiple drawers share the same closet
	// topic and represent stated preferences, the most recent wins. We approximate
	// this by adding a small recency tiebreaker within the same closet+role.
	if (opts.preferenceBoost) {
		const seenLatest = new Map<string, number>()
		for (const drawer of scored) {
			const key = `${drawer.closetId}:${drawer.role}`
			seenLatest.set(key, Math.max(seenLatest.get(key) ?? 0, drawer.occurredAt.getTime()))
		}
		for (const drawer of scored) {
			const key = `${drawer.closetId}:${drawer.role}`
			if (seenLatest.get(key) === drawer.occurredAt.getTime()) {
				drawer.finalScore += 0.05
			}
		}
	}

	scored.sort((a, b) => b.finalScore - a.finalScore)
	return scored.slice(0, opts.topK)
}

/** Group retrieved drawers back into source chat sessions for benchmark scoring. */
export async function recallSessions(
	userId: string,
	query: string,
	options: RecallOptions = {},
): Promise<{ conversationId: string; drawers: RetrievedDrawer[] }[]> {
	const drawers = await recall(userId, query, { ...options, topK: options.topK ?? 5 })
	const grouped = new Map<string, RetrievedDrawer[]>()
	for (const drawer of drawers) {
		const key = drawer.conversationId ?? `room:${drawer.roomId}`
		const arr = grouped.get(key) ?? []
		arr.push(drawer)
		grouped.set(key, arr)
	}
	return [...grouped.entries()].map(([conversationId, list]) => ({ conversationId, drawers: list }))
}

/** Resolve a conversation id back to its `conversations` row label (best-effort). */
export async function resolveConversationLabel(conversationId: string): Promise<string | null> {
	if (!conversationId) return null
	const [row] = await db
		.select({ title: conversations.title })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1)
	return row?.title ?? null
}
