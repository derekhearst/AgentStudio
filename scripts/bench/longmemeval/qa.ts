/**
 * Generate QA hypotheses for a LongMemEval run by feeding the top-K retrieved
 * drawers as RAG context to an LLM.
 *
 * Usage:
 *   bun run scripts/bench/longmemeval/qa.ts --dataset=s --runId=lme_xyz --model=anthropic/claude-sonnet-4 [--topK=10]
 */

import fs from 'node:fs'
import path from 'node:path'
import {
	GENERATION_LOG_DIR,
	RETRIEVAL_LOG_DIR,
	ensureDir,
	loadDataset,
	type DatasetKey,
} from './bench.config'
import { chat } from '../../../src/lib/openrouter.server'

type Args = {
	dataset: DatasetKey
	runId: string
	model: string
	topK: number
	limit?: number
	skip?: number
}

function parseArgs(): Args {
	const out: Record<string, string | number> = { model: 'anthropic/claude-sonnet-4', topK: 10 }
	for (const arg of process.argv.slice(2)) {
		const m = arg.match(/^--([^=]+)=(.+)$/)
		if (m) out[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2])
	}
	if (!out.dataset) throw new Error('--dataset=oracle|s|m required')
	if (!out.runId) throw new Error('--runId=<id> required')
	return out as unknown as Args
}

const QA_SYSTEM = `You are answering a question about events from a long, multi-session chat history. You will be given the question, the date the question was asked, and the most relevant pieces of evidence retrieved from memory.

Carefully extract the answer from the evidence. If the evidence is insufficient or contradictory, say so explicitly. Be concise (1-3 sentences).`

function buildPrompt(question: string, questionDate: string, evidence: Array<{ score: number; content: string; wing: string; closet: string }>): string {
	const evidenceBlock = evidence
		.map((e, i) => `[${i + 1}] (${e.wing} › ${e.closet}, score ${e.score.toFixed(3)})\n${e.content}`)
		.join('\n\n')
	return `Today's date: ${questionDate}\n\nRetrieved evidence:\n${evidenceBlock || '(none)'}\n\nQuestion: ${question}\n\nAnswer:`
}

async function main() {
	const args = parseArgs()
	const refs = loadDataset(args.dataset)
	const refMap = new Map(refs.map((r) => [r.question_id, r]))

	const retrievalFile = path.join(RETRIEVAL_LOG_DIR, `${args.runId}.jsonl`)
	if (!fs.existsSync(retrievalFile)) throw new Error(`Run retrieve.ts first; missing ${retrievalFile}`)
	const retrieval = fs
		.readFileSync(retrievalFile, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map(
			(l) =>
				JSON.parse(l) as {
					question_id: string
					retrieval_results: {
						retrieved: Array<{ score: number; content: string; wing: string; closet: string }>
					}
				},
		)

	const slice = retrieval.slice(args.skip ?? 0, (args.skip ?? 0) + (args.limit ?? retrieval.length))

	ensureDir(GENERATION_LOG_DIR)
	const outFile = path.join(GENERATION_LOG_DIR, `${args.runId}.jsonl`)
	const fd = fs.openSync(outFile, 'w')

	console.log(`[qa] runId=${args.runId} model=${args.model} → ${outFile}`)
	let done = 0
	const startedAt = Date.now()
	for (const r of slice) {
		const ref = refMap.get(r.question_id)
		if (!ref) {
			console.warn(`[qa] skipping ${r.question_id} (no ref)`) ;continue
		}
		const evidence = r.retrieval_results.retrieved.slice(0, args.topK)
		const prompt = buildPrompt(ref.question, ref.question_date, evidence)
		try {
			const resp = await chat(
				[
					{ role: 'system', content: QA_SYSTEM },
					{ role: 'user', content: prompt },
				],
				args.model,
			)
			const hypothesis =
				typeof resp.content === 'string'
					? resp.content
					: Array.isArray(resp.content)
						? resp.content
								.map((p: unknown) =>
									typeof p === 'object' && p && 'text' in (p as Record<string, unknown>)
										? String((p as { text: unknown }).text)
										: '',
								)
								.join('')
						: ''
			fs.writeSync(fd, JSON.stringify({ question_id: r.question_id, hypothesis: hypothesis.trim() }) + '\n')
			done += 1
			if (done % 10 === 0 || done === slice.length) {
				const eta = ((Date.now() - startedAt) / done) * (slice.length - done)
				console.log(`[qa] (${done}/${slice.length}) eta=${(eta / 1000).toFixed(0)}s`)
			}
		} catch (err) {
			console.error(`[qa] FAILED ${r.question_id}`, err)
		}
	}
	fs.closeSync(fd)
	console.log(`[qa] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s → ${outFile}`)
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
