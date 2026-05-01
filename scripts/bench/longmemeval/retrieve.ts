/**
 * Run retrieval over an ingested LongMemEval run.
 *
 * For each instance, calls recall() with the question and writes a jsonl line
 * compatible with LongMemEval's `print_retrieval_metrics.py` semantics.
 *
 * Usage:
 *   bun run scripts/bench/longmemeval/retrieve.ts --dataset=s --runId=lme_xyz [--limit=10] [--useRerank]
 */

import fs from 'node:fs'
import path from 'node:path'
import {
	RETRIEVAL_LOG_DIR,
	ensureDir,
	loadDataset,
	syntheticUserId,
	type DatasetKey,
	type LmeInstance,
} from './bench.config'
import { recall } from '../../../src/lib/memory/retrieval.server'
import { rerank } from '../../../src/lib/memory/rerank.server'

type Args = {
	dataset: DatasetKey
	runId: string
	limit?: number
	skip?: number
	topK: number
	candidatePoolSize: number
	useRerank: boolean
}

function parseArgs(): Args {
	const out: Record<string, string | number | boolean> = {
		topK: 10,
		candidatePoolSize: 50,
		useRerank: false,
	}
	for (const arg of process.argv.slice(2)) {
		if (arg === '--useRerank') {
			out.useRerank = true
			continue
		}
		const m = arg.match(/^--([^=]+)=(.+)$/)
		if (!m) continue
		const [, k, v] = m
		out[k] = isNaN(Number(v)) ? v : Number(v)
	}
	if (!out.dataset) throw new Error('--dataset=oracle|s|m required')
	if (!out.runId) throw new Error('--runId=<id> required')
	return out as unknown as Args
}

function buildSessionLevelMetrics(
	hits: Array<{ sessionId: string | null; finalScore: number }>,
	answerSessionIds: string[],
	ks: number[],
): Record<string, number> {
	const out: Record<string, number> = {}
	const truth = new Set(answerSessionIds)
	const orderedSessions: string[] = []
	const seen = new Set<string>()
	for (const hit of hits) {
		const sid = hit.sessionId
		if (!sid) continue
		if (seen.has(sid)) continue
		seen.add(sid)
		orderedSessions.push(sid)
	}
	for (const k of ks) {
		const topK = orderedSessions.slice(0, k)
		const matches = topK.filter((s) => truth.has(s)).length
		out[`recall_all@${k}`] = truth.size === 0 ? 0 : matches === truth.size ? 1 : 0
		out[`ndcg_any@${k}`] = topK.some((s) => truth.has(s)) ? 1 : 0
	}
	return out
}

async function retrieveOne(args: Args, instance: LmeInstance) {
	const userId = syntheticUserId(args.runId, instance.question_id)
	const initial = await recall(userId, instance.question, {
		topK: args.useRerank ? args.candidatePoolSize : Math.max(args.topK, 50),
		candidatePoolSize: args.candidatePoolSize,
		queryDate: new Date(instance.question_date),
	})
	const final = args.useRerank
		? await rerank(instance.question, initial, { keepTopK: Math.max(args.topK, 50) })
		: initial

	const sessionMetrics = buildSessionLevelMetrics(
		final.map((h) => ({ sessionId: h.roomLabel ?? null, finalScore: h.finalScore })),
		instance.answer_session_ids,
		[5, 10],
	)

	return {
		question_id: instance.question_id,
		question: instance.question,
		retrieval_results: {
			retrieved: final.slice(0, Math.max(args.topK, 50)).map((h) => ({
				drawerId: h.drawerId,
				sessionId: h.roomLabel ?? null,
				score: h.finalScore,
				wing: h.wingName,
				closet: h.closetTopic,
				content: h.content.slice(0, 240),
			})),
			metrics: {
				session: sessionMetrics,
				turn: {},
			},
		},
	}
}

async function main() {
	const args = parseArgs()
	const all = loadDataset(args.dataset)
	const slice = all.slice(args.skip ?? 0, (args.skip ?? 0) + (args.limit ?? all.length))
	ensureDir(RETRIEVAL_LOG_DIR)
	const outPath = path.join(RETRIEVAL_LOG_DIR, `${args.runId}.jsonl`)
	const fd = fs.openSync(outPath, 'w')

	console.log(`[retrieve] dataset=${args.dataset} runId=${args.runId} → ${outPath}`)
	let done = 0
	const startedAt = Date.now()
	for (const instance of slice) {
		try {
			const entry = await retrieveOne(args, instance)
			fs.writeSync(fd, JSON.stringify(entry) + '\n')
			done += 1
			if (done % 10 === 0 || done === slice.length) {
				const eta = ((Date.now() - startedAt) / done) * (slice.length - done)
				console.log(`[retrieve] (${done}/${slice.length}) eta=${(eta / 1000).toFixed(0)}s`)
			}
		} catch (err) {
			console.error(`[retrieve] FAILED ${instance.question_id}`, err)
		}
	}
	fs.closeSync(fd)
	console.log(`[retrieve] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s → ${outPath}`)
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
