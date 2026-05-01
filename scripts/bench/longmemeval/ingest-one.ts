/** Re-ingest a single qid into an existing runId. */
import { db } from '../../../src/lib/db.server'
import { users } from '../../../src/lib/auth/auth.schema'
import { eq } from 'drizzle-orm'
import { mineSession, type MiningSession } from '../../../src/lib/memory/mining.server'
import { loadDataset, syntheticUserId, type DatasetKey } from './bench.config'

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a) => a.match(/^--([^=]+)=(.+)$/))
		.filter((m): m is RegExpMatchArray => Boolean(m))
		.map((m) => [m[1], m[2]]),
)
const dataset = (args.dataset as DatasetKey) ?? 's'
const runId = args.runId
const qid = args.qid
if (!runId || !qid) throw new Error('--runId and --qid required')

const all = loadDataset(dataset)
const instance = all.find((i) => i.question_id === qid)
if (!instance) throw new Error(`qid ${qid} not found in ${dataset}`)
const userId = syntheticUserId(runId, qid)

const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
if (!existing) {
	await db
		.insert(users)
		.values({
			id: userId,
			name: `LongMemEval ${qid}`,
			username: `lme_${userId.slice(0, 8)}`,
			role: 'user',
			isActive: false,
		})
		.onConflictDoNothing()
}

let total = 0
for (let i = 0; i < instance.haystack_sessions.length; i++) {
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
			sourceMessageId: null as string | null,
		}))
	if (turns.length === 0) continue
	const ms: MiningSession = { conversationId: null, occurredAt, sessionLabel: sessionId, turns }
	const r = await mineSession({ userId, agentId: null, session: ms })
	total += r.drawerIds.length
}
console.log(`[reingest-one] ${qid} drawers=${total}`)
process.exit(0)
