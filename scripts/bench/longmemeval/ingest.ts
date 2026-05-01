/**
 * Ingest a LongMemEval dataset into the memory palace.
 *
 * Usage:
 *   bun run scripts/bench/longmemeval/ingest.ts --dataset=s --runId=lme_xyz --limit=10
 *
 * For each instance we:
 *   1. Create (or reuse) a synthetic user row whose id is a hash of (runId, question_id).
 *   2. Replay each haystack_session as a MiningSession at the corresponding haystack_date.
 *   3. Persist via mineSession() — the same code path used by the chat integration.
 */

import { db } from '../../../src/lib/db.server'
import { users } from '../../../src/lib/auth/auth.schema'
import { eq } from 'drizzle-orm'
import { mineSession, type MiningSession } from '../../../src/lib/memory/mining.server'
import { loadDataset, syntheticUserId, syntheticUuid, type DatasetKey, type LmeInstance } from './bench.config'

type Args = {
	dataset: DatasetKey
	runId: string
	limit?: number
	skip?: number
	concurrency: number
	maxSessions?: number
}

function parseArgs(): Args {
	const out: Partial<Args> & Record<string, string | number> = { concurrency: 1 }
	for (const arg of process.argv.slice(2)) {
		const m = arg.match(/^--([^=]+)=(.+)$/)
		if (!m) continue
		const [, k, v] = m
		;(out as Record<string, string | number>)[k] = isNaN(Number(v)) ? v : Number(v)
	}
	if (!out.dataset) throw new Error('--dataset=oracle|s|m required')
	if (!out.runId) throw new Error('--runId=<id> required')
	return out as Args
}

async function ensureUser(userId: string, label: string) {
	const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
	if (existing) return
	await db
		.insert(users)
		.values({
			id: userId,
			name: `LongMemEval ${label}`,
			username: `lme_${userId.slice(0, 8)}`,
			role: 'user',
			isActive: false,
		})
		.onConflictDoNothing()
}

async function ingestInstance(
	runId: string,
	instance: LmeInstance,
	maxSessions?: number,
): Promise<{ drawers: number; sessions: number }> {
	const userId = syntheticUserId(runId, instance.question_id)
	await ensureUser(userId, instance.question_id)

	// Determine which session indices to ingest. Always keep answer-bearing sessions.
	const total = instance.haystack_sessions.length
	const answerIdx = new Set<number>()
	for (let i = 0; i < total; i += 1) {
		const sess = instance.haystack_sessions[i]
		if (sess.some((t) => !!t.has_answer)) answerIdx.add(i)
	}
	let indices: number[]
	if (maxSessions && maxSessions < total) {
		const keep = new Set<number>(answerIdx)
		let i = 0
		while (keep.size < maxSessions && i < total) {
			keep.add(i)
			i += 1
		}
		indices = [...keep].sort((a, b) => a - b)
	} else {
		indices = Array.from({ length: total }, (_, i) => i)
	}

	let totalDrawers = 0
	for (const i of indices) {
		const session = instance.haystack_sessions[i]
		const dateStr = instance.haystack_dates[i] ?? instance.question_date
		const sessionId = instance.haystack_session_ids[i] ?? `s${i}`
		const occurredAt = new Date(dateStr)
		if (Number.isNaN(occurredAt.getTime())) continue

		const turns = session
			.filter((t) => typeof t.content === 'string' && t.content.trim().length > 0)
			.map((t) => ({
				role: t.role as 'user' | 'assistant',
				content: t.content,
				hasAnswer: !!t.has_answer,
				sourceMessageId: null,
			}))
		if (turns.length === 0) continue

		const miningSession: MiningSession = {
			conversationId: null,
			occurredAt,
			sessionLabel: sessionId,
			turns,
		}

		const result = await mineSession({
			userId,
			agentId: null,
			session: miningSession,
		})
		totalDrawers += result.drawerIds.length
	}
	return { drawers: totalDrawers, sessions: indices.length }
}

async function main() {
	const args = parseArgs()
	const all = loadDataset(args.dataset)
	const slice = all.slice(args.skip ?? 0, (args.skip ?? 0) + (args.limit ?? all.length))
	console.log(`[ingest] dataset=${args.dataset} runId=${args.runId} instances=${slice.length}`)

	let done = 0
	const startedAt = Date.now()
	for (const instance of slice) {
		try {
			const { drawers, sessions } = await ingestInstance(args.runId, instance, args.maxSessions)
			done += 1
			const eta = ((Date.now() - startedAt) / done) * (slice.length - done)
			console.log(
				`[ingest] (${done}/${slice.length}) ${instance.question_id} sessions=${sessions} drawers=${drawers} eta=${(eta / 1000).toFixed(0)}s`,
			)
		} catch (err) {
			console.error(`[ingest] FAILED ${instance.question_id}`, err)
		}
	}
	console.log(`[ingest] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
