/**
 * Aggregate retrieval metrics from a jsonl produced by retrieve.ts.
 *
 * Mirrors `vendor/LongMemEval/src/evaluation/print_retrieval_metrics.py`.
 *
 * Usage:
 *   bun run scripts/bench/longmemeval/score-retrieval.ts --runId=lme_xyz
 */

import fs from 'node:fs'
import path from 'node:path'
import { RETRIEVAL_LOG_DIR } from './bench.config'

function parseArgs() {
	const out: Record<string, string> = {}
	for (const arg of process.argv.slice(2)) {
		const m = arg.match(/^--([^=]+)=(.+)$/)
		if (m) out[m[1]] = m[2]
	}
	if (!out.runId) throw new Error('--runId=<id> required')
	return { runId: out.runId, file: out.file }
}

function mean(xs: number[]): number {
	if (xs.length === 0) return 0
	return xs.reduce((a, b) => a + b, 0) / xs.length
}

function main() {
	const args = parseArgs()
	const file = args.file ?? path.join(RETRIEVAL_LOG_DIR, `${args.runId}.jsonl`)
	if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`)
	const entries = fs
		.readFileSync(file, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { question_id: string; retrieval_results: { metrics: { session: Record<string, number> } } })
		// LongMemEval skips abstention questions in retrieval scoring
		.filter((e) => !e.question_id.includes('_abs'))

	const sessionMetricNames = ['recall_all@5', 'ndcg_any@5', 'recall_all@10', 'ndcg_any@10']

	console.log(`[score-retrieval] ${entries.length} instances (abstention excluded)`)
	console.log('Session-level metrics:')
	for (const name of sessionMetricNames) {
		const values = entries.map((e) => e.retrieval_results.metrics.session[name] ?? 0)
		console.log(`\t${name} = ${mean(values).toFixed(4)} (n=${values.length})`)
	}
}

main()
