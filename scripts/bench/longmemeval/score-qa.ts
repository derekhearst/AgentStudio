/**
 * QA judge — calls a strong model (default openai/gpt-4o) via OpenRouter to
 * label each hypothesis yes/no, then prints aggregated accuracy by question_type.
 *
 * Mirrors `vendor/LongMemEval/src/evaluation/{evaluate_qa,print_qa_metrics}.py`.
 *
 * Usage:
 *   bun run scripts/bench/longmemeval/score-qa.ts --dataset=s --runId=lme_xyz [--judgeModel=openai/gpt-4o]
 */

import fs from 'node:fs'
import path from 'node:path'
import { GENERATION_LOG_DIR, loadDataset, type DatasetKey, type LmeInstance } from './bench.config'
import { chat } from '../../../src/lib/openrouter.server'
import { logLlmUsage } from '../../../src/lib/cost/usage'

type Args = {
	dataset: DatasetKey
	runId: string
	judgeModel: string
	limit?: number
}

function parseArgs(): Args {
	const out: Record<string, string | number> = { judgeModel: 'openai/gpt-4o' }
	for (const arg of process.argv.slice(2)) {
		const m = arg.match(/^--([^=]+)=(.+)$/)
		if (m) out[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2])
	}
	if (!out.dataset) throw new Error('--dataset=oracle|s|m required')
	if (!out.runId) throw new Error('--runId=<id> required')
	return out as unknown as Args
}

function judgePrompt(qtype: string, question: string, answer: string, response: string, abstention: boolean): string {
	if (abstention) {
		return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
	}
	if (qtype === 'temporal-reasoning') {
		return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
	}
	if (qtype === 'knowledge-update') {
		return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
	}
	if (qtype === 'single-session-preference') {
		return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
	}
	return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`
}

async function judge(model: string, prompt: string): Promise<boolean> {
	const resp = await chat([{ role: 'user', content: prompt }], model)
	void logLlmUsage({
		source: 'memory_qa',
		model,
		tokensIn: resp.usage?.promptTokens ?? 0,
		tokensOut: resp.usage?.completionTokens ?? 0,
		metadata: {},
	}).catch(() => undefined)
	const text =
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
	return /\byes\b/i.test(text)
}

function mean(xs: number[]): number {
	if (xs.length === 0) return 0
	return xs.reduce((a, b) => a + b, 0) / xs.length
}

async function main() {
	const args = parseArgs()
	const refs = loadDataset(args.dataset)
	const refMap = new Map<string, LmeInstance>(refs.map((r) => [r.question_id, r]))
	const hypFile = path.join(GENERATION_LOG_DIR, `${args.runId}.jsonl`)
	const evalFile = `${hypFile}.eval.jsonl`
	if (!fs.existsSync(hypFile)) throw new Error(`Run qa.ts first; missing ${hypFile}`)
	const hyps = fs
		.readFileSync(hypFile, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as { question_id: string; hypothesis: string })
	const slice = hyps.slice(0, args.limit ?? hyps.length)
	const fd = fs.openSync(evalFile, 'w')

	const qtypeAcc = new Map<string, number[]>()
	const abstentionAcc: number[] = []
	const allAcc: number[] = []

	console.log(`[score-qa] runId=${args.runId} judge=${args.judgeModel} → ${evalFile}`)
	let done = 0
	const startedAt = Date.now()
	for (const h of slice) {
		const ref = refMap.get(h.question_id)
		if (!ref) continue
		const isAbs = h.question_id.includes('_abs')
		const prompt = judgePrompt(ref.question_type, ref.question, ref.answer, h.hypothesis, isAbs)
		try {
			const label = await judge(args.judgeModel, prompt)
			fs.writeSync(
				fd,
				JSON.stringify({
					...h,
					autoeval_label: { model: args.judgeModel, label },
				}) + '\n',
			)
			const v = label ? 1 : 0
			allAcc.push(v)
			if (isAbs) abstentionAcc.push(v)
			const arr = qtypeAcc.get(ref.question_type) ?? []
			arr.push(v)
			qtypeAcc.set(ref.question_type, arr)
			done += 1
			if (done % 10 === 0 || done === slice.length) {
				const eta = ((Date.now() - startedAt) / done) * (slice.length - done)
				console.log(`[score-qa] (${done}/${slice.length}) eta=${(eta / 1000).toFixed(0)}s`)
			}
		} catch (err) {
			console.error(`[score-qa] FAILED ${h.question_id}`, err)
		}
	}
	fs.closeSync(fd)

	console.log('\nEvaluation results by task:')
	const taskAccMeans: number[] = []
	for (const [qtype, vs] of qtypeAcc) {
		const m = mean(vs)
		taskAccMeans.push(m)
		console.log(`\t${qtype}: ${m.toFixed(4)} (${vs.length})`)
	}
	console.log(`\nTask-averaged Accuracy: ${mean(taskAccMeans).toFixed(4)}`)
	console.log(`Overall Accuracy: ${mean(allAcc).toFixed(4)}`)
	console.log(`Abstention Accuracy: ${mean(abstentionAcc).toFixed(4)} (${abstentionAcc.length})`)
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
