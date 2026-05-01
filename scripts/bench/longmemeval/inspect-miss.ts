import fs from 'node:fs'
import path from 'node:path'
import { RETRIEVAL_LOG_DIR, loadDataset } from './bench.config'

const runId = process.argv[2] ?? 'lme_20260501191334_nsin'
const dataset = (process.argv[3] ?? 's') as 'oracle' | 's' | 'm'
const lines = fs
	.readFileSync(path.join(RETRIEVAL_LOG_DIR, `${runId}.jsonl`), 'utf8')
	.split('\n')
	.filter(Boolean)
const all = loadDataset(dataset)
for (const line of lines) {
	const entry = JSON.parse(line)
	const inst = all.find((i) => i.question_id === entry.question_id)
	if (!inst) continue
	const truth = new Set(inst.answer_session_ids)
	const retrievedSessions = entry.retrieval_results.retrieved.map((r: { sessionId: string }) => r.sessionId)
	const seen = new Set<string>()
	const ordered: string[] = []
	for (const s of retrievedSessions) {
		if (s && !seen.has(s)) {
			seen.add(s)
			ordered.push(s)
		}
	}
	const top10 = ordered.slice(0, 10)
	const ok = [...truth].every((t) => top10.includes(t))
	if (!ok) {
		console.log('=== MISS ===')
		console.log('qid:', inst.question_id)
		console.log('question:', inst.question)
		console.log('truth:', [...truth])
		console.log('top10:', top10)
		const truthIdx = ordered.findIndex((s) => truth.has(s))
		console.log(`truth rank in full ranking: ${truthIdx >= 0 ? truthIdx : 'NOT FOUND'} (of ${ordered.length})`)
		console.log('top1 content:', entry.retrieval_results.retrieved[0]?.content)
	}
}
process.exit(0)
